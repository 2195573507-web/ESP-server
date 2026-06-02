const express = require("express");
const sqlite3 = require("sqlite3").verbose();

const app = express();

app.use(express.json());

// 数据库连接
const db = new sqlite3.Database("./db/database.db");

// 首页
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        message: "ESP Server Running"
    });
});

// 获取最新 ASR
app.get("/asr/latest", (req, res) => {
    db.get(
        "SELECT * FROM asr_records ORDER BY id DESC LIMIT 1",
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(row || {});
        }
    );
});

// 写入 ASR
app.post("/asr", (req, res) => {
    const { text } = req.body;

    db.run(
        "INSERT INTO asr_records(timestamp,text) VALUES(?,?)",
        [Date.now(), text],
        function (err) {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success: true,
                id: this.lastID
            });
        }
    );
});
// 获取最新 LLM
app.get("/llm/latest", (req, res) => {
    db.get(
        "SELECT * FROM llm_records ORDER BY id DESC LIMIT 1",
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(row || {});
        }
    );
});

// 写入 LLM
app.post("/llm", (req, res) => {
    const { prompt, response } = req.body;

    db.run(
        "INSERT INTO llm_records(timestamp,prompt,response) VALUES(?,?,?)",
        [Date.now(), prompt, response],
        function (err) {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success: true,
                id: this.lastID
            });
        }
    );
});
// 获取最新 Sensor
app.get("/sensor/latest", (req, res) => {
    db.get(
        "SELECT * FROM sensor_records ORDER BY id DESC LIMIT 1",
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(row || {});
        }
    );
});

// 写入 Sensor
app.post("/sensor", (req, res) => {
    const {
        temperature,
        humidity,
        pressure,
        gas_resistance
    } = req.body;

    db.run(
        `INSERT INTO sensor_records
        (timestamp,temperature,humidity,pressure,gas_resistance)
        VALUES(?,?,?,?,?)`,
        [
            Date.now(),
            temperature,
            humidity,
            pressure,
            gas_resistance
        ],
        function (err) {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success: true,
                id: this.lastID
            });
        }
    );
});
// Dashboard
app.get("/dashboard", (req, res) => {

    db.get(
        "SELECT * FROM asr_records ORDER BY id DESC LIMIT 1",
        [],
        (err, asrRow) => {

            db.get(
                "SELECT * FROM llm_records ORDER BY id DESC LIMIT 1",
                [],
                (err, llmRow) => {

                    db.get(
                        "SELECT * FROM sensor_records ORDER BY id DESC LIMIT 1",
                        [],
                        (err, sensorRow) => {

                            res.send(`
                                <html>
                                <head>
                                    <title>ESP Dashboard</title>
                                    <meta charset="utf-8">
                                </head>
                                <body style="font-family:Arial;padding:30px">

                                    <h1>ESP Dashboard</h1>

                                    <hr>

                                    <h2>最新 ASR</h2>
                                    <pre>${JSON.stringify(asrRow, null, 2)}</pre>

                                    <h2>最新 LLM</h2>
                                    <pre>${JSON.stringify(llmRow, null, 2)}</pre>

                                    <h2>最新 Sensor</h2>
                                    <pre>${JSON.stringify(sensorRow, null, 2)}</pre>

                                </body>
                                </html>
                            `);

                        }
                    );

                }
            );

        }
    );

});
app.listen(3000, () => {
    console.log("Server running on port 3000");
});

