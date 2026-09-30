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
const commands = new Map();
const commandHistory = [];
const adminSessions = new Map();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

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

function requireAdmin(req, res, next) {
    const token = parseCookies(req).wonder_admin;
    if (!token || !adminSessions.has(token)) {
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
    "CLEAR_APP_DATA"
]);

function now() {
    return new Date().toISOString();
}

function cleanDevice(device) {
    return {
        deviceId: device.deviceId,
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

    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, { createdAt: Date.now() });
    res.setHeader("Set-Cookie", `wonder_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
    res.json({ success: true });
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
    res.json({ authenticated: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    const token = parseCookies(req).wonder_admin;
    adminSessions.delete(token);
    res.setHeader("Set-Cookie", "wonder_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
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
 * Admin: get one device.
 */
app.get(
    "/api/admin/devices/:deviceId",
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
