require("dotenv").config()

const express = require("express")
const session = require("express-session")
const { ImapFlow } = require("imapflow")
const { simpleParser } = require("mailparser")
const app = express()

app.set("view engine", "ejs")
app.use(express.urlencoded({ extended: true }))

app.use(session({
    secret: "cmh9-secret",
    resave: false,
    saveUninitialized: false
}))

/* =========================================
HTML → CLEAN TEXT
========================================= */

function htmlToText(html) {

    html = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    html = html.replace(/<style[\s\S]*?<\/style>/gi, "")

    html = html.replace(/<br\s*\/?>/gi, "\n")
    html = html.replace(/<\/p>/gi, "\n")

    html = html.replace(/<[^>]+>/g, "")

    html = html.replace(/\n\s*\n+/g, "\n\n")

    return html.trim()
}

/* =========================================
HEADER CLEANER (Python logic)
========================================= */

function cleanHeaders(email, options) {

    const headers_to_remove = [
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

    const lines = email.split(/\r?\n/);

    let cleaned = [];
    let skipBlock = false;
    let ccExists = false;

    for (let line of lines) {
        if (/^Cc:/i.test(line))
            ccExists = true;
    }

    for (let line of lines) {

        if (/^(Delivered-To:|ARC-|DKIM-Signature:|X-Received:|X-Google-Smtp-Source:|Authentication-Results:|Received-SPF:|Return-Path:|Sender:)/i.test(line)) {
            skipBlock = true;
            continue;
        }

        if (skipBlock) {

            if (/^[A-Za-z-]+:/.test(line)) {
                skipBlock = false;
            } else {
                continue;
            }

        }

        if (/^Date:/i.test(line)) {
            cleaned.push("Date: [DATE]");
            continue;
        }

        if (/^Message-ID:/i.test(line)) {

            let match = line.match(/<([^>]+)>/);

            if (match) {

                let msg = match[1];

                if (msg.includes("@"))
                    msg = msg.replace("@", (options.eid || "[EID]") + "@");

                cleaned.push(`Message-ID: <${msg}>`);
                continue;
            }
        }

        if (/^From:/i.test(line)) {

            let match = line.match(/<([^@>]+)@([^>]+)>/);

            if (match) {

                let local = match[1];
                let domain = options.domain || "[RP]";

                line = line.replace(
                    /<([^@>]+)@([^>]+)>/,
                    `<${local}@${domain}>`
                );
            }

            cleaned.push(line);

            if (options.addSender)
                cleaned.push(`Sender: noreply@${options.domain || "[RP]"}`);

            continue;
        }

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

/* =========================================
EXTRACT JUST TEXT (Python-like logic)
========================================= */

function extractJustText(raw) {

    // نقسم headers / body
    const parts = raw.split(/\r?\n\r?\n/);
    if (parts.length < 2) return "";

    let body = parts.slice(1).join("\n\n");

    // نحاول نلقى text/plain
    let plainMatch = body.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(--|$)/i);

    if (plainMatch) {
        return plainMatch[1].trim();
    }

    // إذا ما كانش plain نحاول html
    let htmlMatch = body.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(--|$)/i);

    if (htmlMatch) {

        let html = htmlMatch[1];

        html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
        html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
        html = html.replace(/<br\s*\/?>/gi, "\n");
        html = html.replace(/<\/p>/gi, "\n");
        html = html.replace(/<[^>]+>/g, "");
        html = html.replace(/\n\s*\n+/g, "\n\n");

        return html.trim();
    }

    return "";
}
/* =========================================
ROUTES
========================================= */

app.get("/", (req, res) => {

    res.render("access", { error: null })

})

app.post("/access", (req, res) => {

    if (req.body.code === process.env.ACCESS_CODE) {

        req.session.auth = true
        return res.redirect("/dashboard")

    }

    res.render("access", { error: "Wrong Code" })

})

app.get("/dashboard", (req, res) => {

    if (!req.session.auth)
        return res.redirect("/")

    res.render("extractor", {
        labels: [],
        error: null,
        email: "",
        password: ""
    })

})

/* =========================================
CONNECT
========================================= */

app.post("/connect", async (req, res) => {

    const { email, password } = req.body

    try {

        const client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: { user: email, pass: password }
        })

        await client.connect()

        let boxes = await client.list()

        let labels = boxes.map(b => b.path)

        await client.logout()

        req.session.email = email
        req.session.password = password

        res.render("extractor", {
            labels,
            error: null,
            email,
            password
        })

    } catch (err) {

        res.render("extractor", {
            labels: [],
            error: "Connection Failed",
            email,
            password
        })
    }

})

/* =========================================
EXTRACT
========================================= */

app.post("/extract", async (req, res) => {

    try {

        const { email, password, label, start, limit, mode } = req.body

        const client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: { user: email, pass: password }
        })

        await client.connect()

        let lock = await client.getMailboxLock(label)

        let startNum = parseInt(start)
        let endNum = startNum + parseInt(limit) - 1

        let results = []

        for await (let msg of client.fetch(`${startNum}:${endNum}`, { source: true })) {

            let raw = msg.source.toString()

            /* BODY TEXT MODE */

            /* JUST TEXT MODE */

            /* JUST TEXT MODE */

            if (mode === "justtext") {

    try {

        const parsed = await simpleParser(raw)

        let text = parsed.text || ""

        if (!text && parsed.html)
            text = htmlToText(parsed.html)

        if (text && text.trim().length > 0)
            results.push(text.trim())

    } catch (e) {
        console.log("JUSTTEXT ERROR:", e)

    }

}
            /* CLEAN HEADERS */

            else if (mode === "clean") {

                let cleaned = cleanHeaders(raw, {
                    domain: req.body.domain,
                    eid: req.body.eid,
                    addSender: req.body.addSender
                })

                results.push(cleaned)
            }
        }

        lock.release()
        await client.logout()

        if (results.length === 0)
            throw new Error("No emails found")

        let finalFile = results.join("\n__SEP__\n")

        res.setHeader(
            "Content-Disposition",
            "attachment; filename=merged_emails.txt"
        )

        res.setHeader("Content-Type", "text/plain")

        res.send(finalFile)

    } catch (err) {

        console.log(err)

        res.send("❌ Extraction Failed")

    }

})

/* =========================================
LOGOUT
========================================= */

app.get("/logout", (req, res) => {

    req.session.destroy()
    res.redirect("/")

})

/* =========================================
SERVER
========================================= */

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {

    console.log("🔥 CMH9 Extractor running on port " + PORT)

})