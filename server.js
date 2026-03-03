require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { ImapFlow } = require("imapflow");

const app = express();

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: "karim-secret",
    resave: false,
    saveUninitialized: false
}));

/* ===================================================== */
/* HEADER PROCESSOR  (MATCH PYTHON VERSION 1:1) */
/* ===================================================== */

function processHeaders(rawEmail, options) {

    const headersToRemove = [
        'Delivered-To',
        'ARC-Seal',
        'ARC-Message-Signature',
        'ARC-Authentication-Results',
        'Return-Path',
        'Received-SPF',
        'Authentication-Results',
        'DKIM-Signature',
        'Sender',
        'X-Received',
        'X-Google-Smtp-Source'
    ];

    const lines = rawEmail.split(/\r?\n/);
    let cleaned = [];

    let skipSection = false;
    let ccExists = false;

    // detect CC existence
    for (let line of lines) {
        if (/^Cc:/i.test(line)) {
            ccExists = true;
        }
    }

    for (let line of lines) {

        // ===== REMOVE HEADERS + MULTILINE =====
        let headerMatch = headersToRemove.find(h =>
            new RegExp("^" + h + ":", "i").test(line)
        );

        if (headerMatch) {
            skipSection = true;
            continue;
        }

        if (skipSection) {
            if (/^[A-Za-z-]+:/.test(line)) {
                skipSection = false;
            } else {
                continue;
            }
        }

        // ===== DATE =====
        if (/^Date:/i.test(line)) {
            cleaned.push("Date: [DATE]");
            continue;
        }

        // ===== MESSAGE-ID =====
        if (/^Message-ID:/i.test(line)) {

            let match = line.match(/<([^>]+)>/);

            if (match) {
                let msgId = match[1];

                if (msgId.includes("@")) {
                    let eidValue = options.eid || "[EID]";
                    msgId = msgId.replace("@", `${eidValue}@`);
                }

                cleaned.push(`Message-ID: <${msgId}>`);
                continue;
            }
        }

        // ===== FROM (replace domain only) =====
        if (/^From:/i.test(line)) {

            let modified = line;

            let match = line.match(/<([^@>]+)@([^>]+)>/);

            if (match) {
                let local = match[1];
                let newDomain = options.domain || "[RDNS]";
                modified = line.replace(
                    /<([^@>]+)@([^>]+)>/,
                    `<${local}@${newDomain}>`
                );
            }

            cleaned.push(modified);

            // add Sender under From
            if (options.addSender) {
                cleaned.push(`Sender: noreply@${options.domain || "[RDNS]"}`);
            }

            continue;
        }

        // ===== TO =====
        if (/^To:/i.test(line)) {

            cleaned.push("To: [*to]");

            if (!ccExists) {
                cleaned.push("Cc: [*to]");
                ccExists = true;
            }

            continue;
        }

        cleaned.push(line);
    }

    return cleaned.join("\n");
}

/* ===================================================== */
/* ROUTES */
/* ===================================================== */

app.get("/", (req, res) => {
    res.render("access", { error: null });
});

app.post("/access", (req, res) => {
    const { code } = req.body;

    if (code === process.env.ACCESS_CODE) {
        req.session.authorized = true;
        return res.redirect("/dashboard");
    }

    res.render("access", { error: "Wrong Access Code" });
});

app.get("/dashboard", (req, res) => {
    if (!req.session.authorized) return res.redirect("/");

    res.render("extractor", {
        labels: [],
        error: null,
        email: req.session.email || "",
        password: req.session.password || ""
    });
});

/* ================= CONNECT ================= */

app.post("/connect", async (req, res) => {

    if (!req.session.authorized) return res.redirect("/");

    const { email, password } = req.body;

    try {

        const client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: { user: email, pass: password }
        });

        await client.connect();

        let mailboxes = await client.list();
        let labels = mailboxes.map(box => box.path);

        await client.logout();

        req.session.email = email;
        req.session.password = password;

        res.render("extractor", {
            labels,
            error: null,
            email,
            password
        });

    } catch (err) {

        res.render("extractor", {
            labels: [],
            error: "Connection Failed",
            email,
            password
        });
    }
});

/* ================= EXTRACT ================= */

app.post("/extract", async (req, res) => {

    try {

        const { email, password, label, start, limit } = req.body;

        const client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: { user: email, pass: password }
        });

        await client.connect();
        let lock = await client.getMailboxLock(label);

        let startNum = parseInt(start);
        let endNum = startNum + parseInt(limit) - 1;

        let results = [];

        for await (let msg of client.fetch(`${startNum}:${endNum}`, { source: true })) {

            let raw = msg.source.toString();

            let cleaned = processHeaders(raw, {
                domain: req.body.domain,
                eid: req.body.eid,
                addSender: !!req.body.addSender
            });

            results.push(cleaned);
        }

        lock.release();
        await client.logout();

        if (results.length === 0) {
            throw new Error("No emails found.");
        }

        let finalFile = results.join("\n__SEP__\n");

        res.setHeader("Content-Disposition", "attachment; filename=merged_emails.txt");
        res.setHeader("Content-Type", "text/plain");

        res.send(finalFile);

    } catch (err) {
        console.error(err);
        res.send("❌ Extraction Failed: " + err.message);
    }
});

/* ================= LOGOUT ================= */

app.get("/logout", (req, res) => {
    req.session.destroy();
    res.redirect("/");
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🔥 Running on port " + PORT);
});