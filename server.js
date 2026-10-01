const express = require("express");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const VERSION = "2.0.0";

/*
 * First production-compatible management server for
 * the current InfinityMetaKiosk Android client.
 *
 * Storage is intentionally in-memory for now.
 * Restarting the Render service clears registered devices
 * and queued commands. A database can be added later.
 */
const devices = new Map();

// Built-in test device for validating the Wonder Kiosk admin dashboard.
// This is clearly marked as synthetic and does not represent a real tablet.
const TEST_DEVICE_ID = "TEST-WONDER-KIOSK-001";
devices.set(TEST_DEVICE_ID, {
    deviceId: TEST_DEVICE_ID,
    model: "Wonder Kiosk Test Tablet",
    manufacturer: "Wonder Tech",
    androidVersion: "Android 16",
    sdk: 35,
    packageName: "com.infinitymeta.kiosk",
    appVersion: "1.0.5",
    status: "online",
    lastSeen: new Date().toISOString(),
    isTestDevice: true
});
const commands = new Map();
commands.set(TEST_DEVICE_ID, []);
const commandHistory = [];

let latestUpdate = {
    versionName: "1.0.6",
    versionCode: 106,
    apkUrl: "",
    sha256: "",
    notes: "Infinity Meta Kiosk update",
    publishedAt: null
};
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_SECRET =
    process.env.ADMIN_SESSION_SECRET ||
    ADMIN_PASSWORD;

const ADMIN_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function parseCookies(req) {
    const header = req.headers.cookie || "";
    return Object.fromEntries(
        header.split(";").filter(Boolean).map(part => {
            const index = part.indexOf("=");
            return [
                part.slice(0, index).trim(),
                decodeURIComponent(part.slice(index + 1).trim())
            ];
        })
    );
}

function createAdminToken() {
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = `wonder|admin|${issuedAt}`;
    const signature = crypto
        .createHmac("sha256", ADMIN_SESSION_SECRET)
        .update(payload)
        .digest("hex");

    return Buffer.from(`${payload}|${signature}`).toString("base64url");
}

function isValidAdminToken(token) {
    try {
        const decoded = Buffer.from(token, "base64url").toString("utf8");
        const parts = decoded.split("|");

        if (parts.length !== 4 || parts[0] !== "wonder" || parts[1] !== "admin") {
            return false;
        }

        const issuedAt = Number(parts[2]);
        if (!Number.isFinite(issuedAt)) {
            return false;
        }

        if (Math.floor(Date.now() / 1000) - issuedAt > ADMIN_SESSION_MAX_AGE) {
            return false;
        }

        const payload = `${parts[0]}|${parts[1]}|${parts[2]}`;
        const expected = crypto
            .createHmac("sha256", ADMIN_SESSION_SECRET)
            .update(payload)
            .digest("hex");

        return crypto.timingSafeEqual(
            Buffer.from(parts[3]),
            Buffer.from(expected)
        );
    } catch {
        return false;
    }
}

function requireAdmin(req, res, next) {
    const token = parseCookies(req).wonder_admin;

    if (!token || !isValidAdminToken(token)) {
        return res.status(401).json({ error: "Admin authentication required" });
    }

    next();
}

const SUPPORTED_COMMANDS = new Set([
    "PING",
    "SHOW_MESSAGE",
    "ENTER_KIOSK",
    "RESTART_KIOSK",
    "EXIT_KIOSK",
    "CLEAR_APP_DATA",
    "REMOVE_KIOSK_APP",
    "SET_DEVICE_NAME",
    "UPDATE_APP"
]);

function now() {
    return new Date().toISOString();
}

function cleanDevice(device) {
    return {
        deviceId: device.deviceId,
        deviceName: device.deviceName || "",
        model: device.model || "unknown",
        androidVersion: device.androidVersion || "unknown",
        sdk: device.sdk ?? null,
        packageName: device.packageName || "unknown",
        appVersion: device.appVersion || "unknown",
        registeredAt: device.registeredAt || now(),
        lastSeen: device.lastSeen || now()
    };
}

function isOnline(device) {
    if (!device || !device.lastSeen) {
        return false;
    }

    return (
        Date.now() -
        new Date(device.lastSeen).getTime()
    ) <= 90_000;
}

function createCommand(type, message) {
    return {
        id:
            Date.now().toString() +
            "-" +
            Math.random()
                .toString(36)
                .substring(2, 10),
        type,
        message: message || "",
        createdAt: now()
    };
}

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "Infinity Meta Kiosk Server",
        version: VERSION,
        api: "/api/",
        supportedCommands: Array.from(
            SUPPORTED_COMMANDS
        )
    });
});

app.post("/api/admin/login", (req, res) => {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
        return res.status(503).json({ error: "Admin login is not configured" });
    }

    const { username, password } = req.body || {};
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = createAdminToken();
    res.setHeader(
        "Set-Cookie",
        `wonder_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_MAX_AGE}`
    );
    res.json({ success: true });
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
    res.json({ authenticated: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    res.setHeader(
        "Set-Cookie",
        "wonder_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    );
    res.json({ success: true });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        service: "Infinity Meta Kiosk Server",
        version: VERSION,
        devices: devices.size,
        queuedCommands: Array.from(
            commands.values()
        ).reduce(
            (total, list) => total + list.length,
            0
        )
    });
});

/*
 * Tablet registration / heartbeat.
 *
 * The Android client calls this when its management
 * service starts. Re-registering also refreshes lastSeen.
 */
app.post("/api/devices/register", (req, res) => {
    const device = req.body || {};

    if (!device.deviceId) {
        return res.status(400).json({
            error: "deviceId is required"
        });
    }

    const existing = devices.get(
        device.deviceId
    );

    const saved = cleanDevice({
        ...existing,
        ...device,
        registeredAt:
            existing?.registeredAt || now(),
        lastSeen: now()
    });

    devices.set(
        device.deviceId,
        saved
    );

    if (!commands.has(device.deviceId)) {
        commands.set(
            device.deviceId,
            []
        );
    }

    res.json({
        success: true,
        message: existing
            ? "Device heartbeat updated"
            : "Device registered",
        device: saved
    });
});

/*
 * Tablet polls for pending commands.
 *
 * Commands are removed from the queue when delivered,
 * matching the current Android client's polling model.
 */
app.post("/api/commands/poll", (req, res) => {
    const deviceId = req.body?.deviceId;

    if (!deviceId) {
        return res.status(400).json({
            error: "deviceId is required"
        });
    }

    const device = devices.get(deviceId);

    if (!device) {
        return res.status(404).json({
            error: "Device not registered"
        });
    }

    device.lastSeen = now();
    devices.set(deviceId, device);

    const deviceCommands =
        commands.get(deviceId) || [];

    commands.set(deviceId, []);

    res.json({
        commands: deviceCommands
    });
});

/*
 * Tablet acknowledges a command.
 */
app.post("/api/commands/ack", (req, res) => {
    const {
        deviceId,
        commandId,
        status,
        message
    } = req.body || {};

    if (!deviceId || !commandId) {
        return res.status(400).json({
            error:
                "deviceId and commandId are required"
        });
    }

    const device = devices.get(deviceId);

    if (device) {
        device.lastSeen = now();
        devices.set(deviceId, device);
    }

    const acknowledgement = {
        deviceId,
        commandId,
        status: status || "UNKNOWN",
        message: message || "",
        acknowledgedAt: now()
    };

    commandHistory.push(
        acknowledgement
    );

    /*
     * Keep memory bounded during long-running tests.
     */
    if (commandHistory.length > 500) {
        commandHistory.splice(
            0,
            commandHistory.length - 500
        );
    }

    console.log(
        "Command acknowledgement:",
        acknowledgement
    );

    res.json({
        success: true,
        acknowledgement
    });
});

/*
 * Admin: list registered devices.
 */
app.get("/api/admin/devices", requireAdmin, (req, res) => {
    const result =
        Array.from(
            devices.values()
        ).map(device => ({
            ...device,
            online: isOnline(device),
            queuedCommands:
                (
                    commands.get(
                        device.deviceId
                    ) || []
                ).length
        }));

    res.json({
        devices: result
    });
});

/*
 * Admin: set a friendly name for one device.
 * The name is stored on the server and also sent to the kiosk
 * so the Android client can persist it locally.
 */
app.post("/api/admin/devices/:deviceId/name", requireAdmin, (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);

    if (!device) {
        return res.status(404).json({ error: "Device not registered" });
    }

    const deviceName = String(req.body?.deviceName || "").trim();

    if (!deviceName) {
        return res.status(400).json({ error: "deviceName is required" });
    }

    if (deviceName.length > 80) {
        return res.status(400).json({ error: "deviceName must be 80 characters or fewer" });
    }

    device.deviceName = deviceName;
    devices.set(deviceId, device);

    const command = createCommand("SET_DEVICE_NAME", JSON.stringify({ deviceName }));
    const queue = commands.get(deviceId) || [];
    queue.push(command);
    commands.set(deviceId, queue);

    if (deviceId === TEST_DEVICE_ID) {
        const acknowledgement = {
            deviceId,
            commandId: command.id,
            status: "TEST_ACK",
            message: "Simulated test-device name update",
            acknowledgedAt: now()
        };
        commandHistory.push(acknowledgement);
        commands.set(deviceId, []);
        return res.json({ success: true, device, command, simulated: true, acknowledgement });
    }

    res.json({ success: true, device, command, simulated: false });
});

/*
 * Admin: get one device.
 */
app.get(
    "/api/admin/devices/:deviceId",
    requireAdmin,
    (req, res) => {
        const device =
            devices.get(
                req.params.deviceId
            );

        if (!device) {
            return res.status(404).json({
                error: "Device not registered"
            });
        }

        res.json({
            device: {
                ...device,
                online: isOnline(device),
                queuedCommands:
                    (
                        commands.get(
                            device.deviceId
                        ) || []
                    ).length
            }
        });

/*
 * Admin: configure and send an APK update.
 * APK delivery remains HTTPS; the Android client verifies the
 * package name, version and SHA-256 before installing.
 */
app.get("/api/admin/update", requireAdmin, (req, res) => {
    res.json({ update: latestUpdate });
});

app.post("/api/admin/update", requireAdmin, (req, res) => {
    const body = req.body || {};
    const versionName = String(body.versionName || "").trim();
    const versionCode = Number(body.versionCode);
    const apkUrl = String(body.apkUrl || "").trim();
    const sha256 = String(body.sha256 || "").trim().toLowerCase();
    const notes = String(body.notes || "").trim();

    if (!versionName || !Number.isInteger(versionCode) || versionCode <= 0) {
        return res.status(400).json({
            error: "versionName and a positive integer versionCode are required"
        });
    }

    if (!/^https:\/\//i.test(apkUrl)) {
        return res.status(400).json({ error: "apkUrl must use HTTPS" });
    }

    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
        return res.status(400).json({
            error: "sha256 must be a 64-character SHA-256 hex string"
        });
    }

    latestUpdate = {
        versionName,
        versionCode,
        apkUrl,
        sha256,
        notes,
        publishedAt: now()
    };

    res.json({ success: true, update: latestUpdate });
});

app.post("/api/admin/update/send", requireAdmin, (req, res) => {
    const deviceIds = Array.isArray(req.body?.deviceIds)
        ? req.body.deviceIds.map(String).filter(Boolean)
        : [];

    if (!deviceIds.length) {
        return res.status(400).json({ error: "At least one deviceId is required" });
    }

    if (!latestUpdate.apkUrl || !latestUpdate.sha256) {
        return res.status(400).json({
            error: "Configure the APK URL and SHA-256 before sending an update"
        });
    }

    const results = [];

    for (const deviceId of deviceIds) {
        if (!devices.has(deviceId)) {
            results.push({ deviceId, queued: false, error: "Device not registered" });
            continue;
        }

        const command = createCommand(
            "UPDATE_APP",
            JSON.stringify({
                apkUrl: latestUpdate.apkUrl,
                versionCode: latestUpdate.versionCode,
                versionName: latestUpdate.versionName,
                sha256: latestUpdate.sha256
            })
        );

        const queue = commands.get(deviceId) || [];
        queue.push(command);
        commands.set(deviceId, queue);

        if (deviceId === TEST_DEVICE_ID) {
            const acknowledgement = {
                deviceId,
                commandId: command.id,
                status: "TEST_ACK",
                message: "Simulated test-device update acknowledgement",
                acknowledgedAt: now()
            };
            commandHistory.push(acknowledgement);
            commands.set(deviceId, []);
            results.push({ deviceId, queued: true, simulated: true, command });
        } else {
            results.push({ deviceId, queued: true, simulated: false, command });
        }
    }

    if (commandHistory.length > 500) {
        commandHistory.splice(0, commandHistory.length - 500);
    }

    res.json({ success: true, update: latestUpdate, results });
});

    }
);

/*
 * Admin: send a command to a device.
 *
 * These command names exactly match the current
 * InfinityMetaKiosk ManagementCommandReceiver.
 */
app.post("/api/admin/command", requireAdmin, (req, res) => {
    const {
        deviceId,
        type,
        message
    } = req.body || {};

    if (!deviceId || !type) {
        return res.status(400).json({
            error:
                "deviceId and type are required"
        });
    }

    if (!SUPPORTED_COMMANDS.has(type)) {
        return res.status(400).json({
            error:
                "Unsupported command type",
            supportedCommands:
                Array.from(
                    SUPPORTED_COMMANDS
                )
        });
    }

    if (!devices.has(deviceId)) {
        return res.status(404).json({
            error:
                "Device not registered"
        });
    }

    const command =
        createCommand(
            type,
            message
        );

    const existing =
        commands.get(deviceId) || [];

    existing.push(command);

    commands.set(
        deviceId,
        existing
    );

    // The synthetic test tablet immediately acknowledges commands,
    // allowing the admin dashboard controls to be tested without
    // a physical Android device.
    if (deviceId === TEST_DEVICE_ID) {
        const acknowledgement = {
            deviceId,
            commandId: command.id,
            status: "TEST_ACK",
            message: "Simulated test-device acknowledgement for " + type,
            acknowledgedAt: now()
        };

        commandHistory.push(acknowledgement);

        if (commandHistory.length > 500) {
            commandHistory.splice(
                0,
                commandHistory.length - 500
            );
        }

        commands.set(deviceId, []);

        return res.json({
            success: true,
            command,
            simulated: true,
            acknowledgement
        });
    }

    res.json({
        success: true,
        command
    });
});

/*
 * Admin: inspect recent acknowledgements.
 */
app.get(
    "/api/admin/command-history",
    requireAdmin,
    (req, res) => {
        const limit = Math.min(
            Math.max(
                Number(req.query.limit) || 50,
                1
            ),
            200
        );

        res.json({
            history:
                commandHistory.slice(
                    -limit
                )
        });
    }
);

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            "Infinity Meta server running on port " +
            PORT +
            " (v" +
            VERSION +
            ")"
        );
    }
);
