const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 数据库连接
const db = new sqlite3.Database(path.join(__dirname, "db", "database.db"));

// 首页跳转到仪表盘
app.get("/", (req, res) => {
    res.redirect("/dashboard");
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
    res.sendFile(path.join(__dirname, "public", "index.html"));
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
