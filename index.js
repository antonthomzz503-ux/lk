import got from "got";
import Pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} from "@whiskeysockets/baileys";

const blacklist = ["62882002954971", "62882000961202"];

async function get_buffer(url) {
    try {
        const response = await got.get(url, {
            responseType: "buffer",
            timeout: { request: 20000 },
            retry: { limit: 1 },
            headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" }
        });

        const buffer = Buffer.from(response.body);

        if (!buffer.length) throw new Error("Buffer kosong");

        return buffer;
    } catch (e) {
        throw new Error(e.message);
    }
}


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
        generateHighQualityLinkPreview: true,
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

    s.ev.on("call", async (calls) => {
        for (const call of calls) {
            if (call.status !== "offer") continue;

            const caller = call.from?.split("@")[0];
            if (!caller) continue;

            const blocked = blacklist.some(number => number.replace(/\D/g, "") === caller.replace(/\D/g, ""));
            if (!blocked) continue;

            await s.rejectCall(call.id, call.from);
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

            const jid = m.key.remoteJid;
            if (jid) await s.readMessages([m.key]);

            const urls = [...body.matchAll(/https?:\/\/[^\s]+/gi)].map(([url]) => url.replace(/[.,!?;)\]]+$/, ""));

            for (const url of [...new Set(urls)]) {
                try {
                    const hostname = new URL(url).hostname.toLowerCase();

                    if (hostname === "vt.mp3tiktok.com" || hostname === "mp3tiktok.com") {
                        const cleanUrl = url.replace(/mp3tiktok\.com/gi, "tiktok.com");
                        const { data } = await got(`https://tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`).json();

                        const audio_url = data?.music || data?.music_info?.play;
                        if (!audio_url) continue;

                        const audio = await get_buffer(audio_url);
                        await s.sendMessage(jid, {
                            audio,
                            mimetype: "audio/mpeg",
                            fileName: "tiktok-audio.mp3",
                            ptt: false
                        });

                        continue;
                    }

                    const isTikTok =
                        hostname === "tiktok.com" ||
                        hostname.endsWith(".tiktok.com");

                    if (!isTikTok) continue;

                    const { data } = await got(`https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`).json();

                    if (Array.isArray(data?.images) && data.images.length) {
                        for (const image_url of data.images) {
                            const image = await get_buffer(image_url);
                            await s.sendMessage(jid, {
                                image,
                                mimetype: "image/jpeg",
                                fileName: "image.jpg"
                            });
                        }

                        continue;
                    }

                    const video_url = data?.hdplay || data?.play;

                    if (video_url) {
                        const video = await get_buffer(video_url);
                        await s.sendMessage(jid, {
                            video,
                            mimetype: "video/mp4",
                            fileName: "video.mp4"
                        });
                    }
                } catch { }
            }
        }
    });
}

main("6283122054460");
