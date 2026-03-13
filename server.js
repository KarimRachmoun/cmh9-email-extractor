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
HEADER CLEANER (Improved Python Logic)
========================================= */

function cleanHeaders(email, options = {}) {

    const removeHeaders = [
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
    ]

    const domain = options.domain || "[RDNS]"
    const eid = options.eid || "[EID]"

    const lines = email.split(/\r?\n/)

    let cleaned = []
    let skip = false
    let ccExists = false

    // check if cc exists
    for (let line of lines) {
        if (/^Cc:/i.test(line))
            ccExists = true
    }

    for (let line of lines) {

        // remove unwanted headers
        if (removeHeaders.some(h => line.toLowerCase().startsWith(h.toLowerCase() + ":"))) {
            skip = true
            continue
        }

        // skip multiline header continuation
        if (skip) {
            if (/^\s/.test(line))
                continue
            skip = false
        }

        // Date
        if (/^Date:/i.test(line)) {
            cleaned.push("Date: [DATE]")
            continue
        }

        // Message-ID
        if (/^Message-ID:/i.test(line)) {

            let match = line.match(/<([^>]+)>/)

            if (match) {

                let msg = match[1]

                if (msg.includes("@"))
                    msg = msg.replace("@", eid + "@")

                cleaned.push(`Message-ID: <${msg}>`)
                continue
            }
        }

        // From
       if (/^From:/i.test(line)) {

    let domain = options.domain || "[RDNS]"

    // email داخل <>
    let angleMatch = line.match(/<([^@>]+)@([^>]+)>/)

    if (angleMatch) {

        let local = angleMatch[1]

        line = line.replace(
            /<([^@>]+)@([^>]+)>/,
            `<${local}@${domain}>`
        )

    } else {

        // email بدون <>
        let emailMatch = line.match(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)/)

        if (emailMatch) {

            let local = emailMatch[1]

            line = line.replace(
                /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)/,
                `${local}@${domain}`
            )
        }
    }

    cleaned.push(line)

    if (options.addSender)
        cleaned.push(`Sender: noreply@[RDNS]`)

    continue
}

        // To
        if (/^To:/i.test(line)) {

            cleaned.push("To: [*to]")

            if (!ccExists) {
                cleaned.push("Cc: [*to]")
                ccExists = true
            }

            continue
        }

        cleaned.push(line)
    }

    return cleaned.join("\n")
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
        let limitNum = parseInt(limit)

        let results = []

        let uids = await client.search({ all: true })

        // newest first (like Gmail)
        uids.reverse()

        let selected = uids.slice(startNum - 1, startNum - 1 + limitNum)

        if (selected.length === 0)
            throw new Error("Start range too big")

        for (let uid of selected) {

            let msg = await client.fetchOne(uid, { source: true })

            let raw = msg.source.toString()

            if (mode === "justtext") {

                const parsed = await simpleParser(raw)

                let text = parsed.text || ""

                if (!text && parsed.html)
                    text = htmlToText(parsed.html)

                if (text && text.trim())
                    results.push(text.trim())

            }

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

        if (!results.length)
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