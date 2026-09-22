const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// In-memory storage for the first test.
// We will replace this with a real database later.
const devices = new Map();
const commands = new Map();

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "Infinity Meta Kiosk Server",
        version: "1.0.0"
    });
});

// Tablet registration
app.post("/api/devices/register", (req, res) => {

    const device = req.body;

    if (!device.deviceId) {
        return res.status(400).json({
            error: "deviceId is required"
        });
    }

    devices.set(device.deviceId, {
        ...device,
        lastSeen: new Date().toISOString()
    });

    res.json({
        success: true,
        message: "Device registered"
    });
});

// Tablet asks for commands
app.post("/api/commands/poll", (req, res) => {

    const deviceId = req.body.deviceId;

    if (!deviceId) {
        return res.status(400).json({
            error: "deviceId is required"
        });
    }

    const deviceCommands =
        commands.get(deviceId) || [];

    commands.set(deviceId, []);

    res.json({
        commands: deviceCommands
    });
});

// Tablet acknowledges command
app.post("/api/commands/ack", (req, res) => {

    console.log(
        "Command acknowledgement:",
        req.body
    );

    res.json({
        success: true
    });
});

// Admin: list registered devices
app.get("/api/admin/devices", (req, res) => {

    res.json({
        devices: Array.from(
            devices.values()
        )
    });
});

// Admin: send command to a device
app.post("/api/admin/command", (req, res) => {

    const {
        deviceId,
        type,
        message
    } = req.body;

    if (!deviceId || !type) {
        return res.status(400).json({
            error: "deviceId and type are required"
        });
    }

    if (!devices.has(deviceId)) {
        return res.status(404).json({
            error: "Device not registered"
        });
    }

    const command = {
        id:
            Date.now().toString() +
            "-" +
            Math.random()
                .toString(36)
                .substring(2, 8),

        type,
        message: message || "",
        createdAt: new Date().toISOString()
    };

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

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `Infinity Meta server running on port ${PORT}`
        );
    }
);
