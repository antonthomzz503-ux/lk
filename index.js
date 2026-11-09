import got from "got";
import Pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} from "@whiskeysockets/baileys";

async function main(phone) {
    const { state, saveCreds } = await useMultiFileAuthState("./tmp");
    const { version } = await fetchLatestBaileysVersion();

    const s = makeWASocket({
        version,
        auth: state,
        logger: new Pino({ level: "silent" }),
        browser: Browsers.windows("Edge"),
        keepAliveIntervalMs: 30_000,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: undefined
    });

    if (!state.creds.registered) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const code = await s.requestPairingCode(phone.replace(/\D/g, ""));
        console.log(`Code: ${code.match(/.{1,4}/g)?.join("-")}`);
    }

    s.ev.on("creds.update", saveCreds);

    s.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "close") {
            const disconnectCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = disconnectCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                setTimeout(() => {
                    main(phone);
                }, 2000);
            }
        }
    });

    s.ev.on("messages.upsert", async ({ messages }) => {
        for (const m of messages) {
            if (!m.message) continue;

            const content = m.message || {};
            const body = [
                content.conversation,
                content.extendedTextMessage?.text,
                content.imageMessage?.caption,
                content.videoMessage?.caption,
                content.documentMessage?.caption
            ].find(v => typeof v === "string" && v.trim())?.trim() || "";

            for (const [url] of body.matchAll(/https?:\/\/(?:vt|vm|www)?\.?tiktok\.com\/[^\s]+/gi)) {
                try {
                    const { data } = await got(`https://tikwm.com/api/?url=${url}&hd=1`).json();

                    if (Array.isArray(data?.images) && data.images.length) {
                        for (const image of data.images) {
                            await s.sendMessage(m.key.remoteJid, {
                                image: { url: image }
                            }, { quotes: m });
                        }

                        continue;
                    }

                    const video_url = data?.hdplay || data?.play;

                    if (video_url) {
                        await s.sendMessage(m.key.remoteJid, {
                            video: { url: video_url },
                            mimeType: "video/mp4"
                        }, { quotes: m });
                    }
                } catch { }
            }
        }
    });
}

main("6283122054460");
