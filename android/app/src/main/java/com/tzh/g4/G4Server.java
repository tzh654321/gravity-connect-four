package com.tzh.g4;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/* ==========================================================================
   联机服务：房间逻辑 + 内置 HTTP 监听
   --------------------------------------------------------------------------
   协议与 四子棋服务器.js 保持一致（同一份房间语义、同样的字段名与错误码），
   因此：手机开房时，局域网内无论是另一个 APK 还是 PC 浏览器，都能直接加入。
   本地模式下 /api/* 不经过网络，由 handleApi 直接处理；
   局域网对外则由 HttpListener 监听端口提供服务。
   ========================================================================== */
public final class G4Server {

    private static final String TAG = "G4Server";
    private static final String CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    private static final long GUEST_TIMEOUT = 20000;   // guest 离线后可被顶替
    private static final long ROOM_TTL = 65000;        // 双方都无请求则回收
    private static final long OFFLINE_AFTER = 15000;   // 判定对手离线
    private static final int MAX_MSGS = 500;

    private G4Server() {}

    /* ---------------- 响应 ---------------- */
    public static final class Resp {
        public final int status;
        public final String body;
        public final String type;
        Resp(int s, String b, String t) { status = s; body = b; type = t; }
        public static Resp json(int s, JSONObject o) { return new Resp(s, o.toString(), "application/json; charset=utf-8"); }
        public static Resp text(int s, String b) { return new Resp(s, b, "text/plain; charset=utf-8"); }
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]);
        } catch (Exception ignored) {}
        return o;
    }
    private static Resp err(int code, String msg) { return Resp.json(code, obj("err", msg)); }

    /* ---------------- 房间 ---------------- */
    private static final class Side {
        final String token;
        volatile long touch = System.currentTimeMillis();
        Side(String t) { token = t; }
    }

    private static final class Room {
        final String code;
        final List<JSONObject> msgs = new ArrayList<>();
        Side host, guest;
        int seq = 0;
        boolean hostReady, guestReady;
        Object firstOwner;

        Room(String c) { code = c; }

        String sideOf(String token) {
            if (token == null || token.isEmpty()) return null;
            if (host != null && token.equals(host.token)) return "host";
            if (guest != null && token.equals(guest.token)) return "guest";
            return null;
        }
        Side get(String s) { return "host".equals(s) ? host : guest; }
        void set(String s, Side v) { if ("host".equals(s)) host = v; else guest = v; }
        void touch(String s) { Side x = get(s); if (x != null) x.touch = System.currentTimeMillis(); }

        synchronized int push(JSONObject m) {
            try { m.put("id", ++seq); } catch (Exception ignored) {}
            msgs.add(m);
            int over = msgs.size() - MAX_MSGS;
            if (over > 0) msgs.subList(0, over).clear();
            return seq;
        }
        synchronized JSONArray since(int from, String side) {
            JSONArray a = new JSONArray();
            for (JSONObject m : msgs) {
                int id = m.optInt("id", 0);
                if (id > from && !side.equals(m.optString("from"))) a.put(m);
            }
            return a;
        }
    }

    private static final ConcurrentHashMap<String, Room> ROOMS = new ConcurrentHashMap<>();
    private static final ScheduledExecutorService CLEANER = Executors.newSingleThreadScheduledExecutor();
    private static volatile boolean cleanerStarted = false;

    private static synchronized void ensureCleaner() {
        if (cleanerStarted) return;
        cleanerStarted = true;
        CLEANER.scheduleWithFixedDelay(new Runnable() {
            @Override public void run() {
                long now = System.currentTimeMillis();
                Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
                while (it.hasNext()) {
                    Room r = it.next().getValue();
                    boolean dh = r.host == null || now - r.host.touch > ROOM_TTL;
                    boolean dg = r.guest == null || now - r.guest.touch > ROOM_TTL;
                    if (dh && dg) it.remove();
                }
            }
        }, 20, 20, TimeUnit.SECONDS);
    }

    private static String makeCode() {
        StringBuilder c;
        do {
            c = new StringBuilder();
            for (int i = 0; i < 4; i++)
                c.append(CODE_CHARS.charAt((int) (Math.random() * CODE_CHARS.length())));
        } while (ROOMS.containsKey(c.toString()));
        return c.toString();
    }

    private static String makeToken() {
        return Long.toString((long) (Math.random() * 0x7fffffffffffffffL), 36)
                + Long.toString(System.currentTimeMillis(), 36);
    }

    private static Room roomOf(String code) {
        if (code == null) return null;
        return ROOMS.get(code.trim().toUpperCase());
    }

    public static int roomCount() { return ROOMS.size(); }

    /* ---------------- API ---------------- */
    public static Resp handleApi(String method, String path, Map<String, String> q, String body) {
        ensureCleaner();
        try {
            if ("/api/ping".equals(path)) return Resp.text(200, "pong");
            if ("/api/create".equals(path)) return apiCreate();
            if ("/api/join".equals(path)) return apiJoin(q);
            if ("/api/send".equals(path)) return apiSend(body);
            if ("/api/poll".equals(path)) return apiPoll(q);
        } catch (Exception e) {
            return err(500, "服务器内部错误: " + e.getMessage());
        }
        return err(404, "未知接口 " + path);
    }

    private static Resp apiCreate() {
        String code = makeCode();
        Room r = new Room(code);
        r.host = new Side(makeToken());
        r.hostReady = false;
        r.guestReady = false;
        ROOMS.put(code, r);
        return Resp.json(200, obj("room", code, "token", r.host.token));
    }

    private static Resp apiJoin(Map<String, String> q) {
        Room r = roomOf(q.get("room"));
        if (r == null) return err(404, "房间不存在");
        String tok = q.get("token");
        long now = System.currentTimeMillis();
        synchronized (r) {
            if (tok != null && !tok.isEmpty() && r.guest != null && tok.equals(r.guest.token)) {
                r.guest.touch = now;
                return Resp.json(200, obj("token", tok, "seq", r.seq));
            }
            if (r.guest != null) {
                if (now - r.guest.touch > GUEST_TIMEOUT) r.guest = null;
                else return err(409, "房间已满（对方在线中）");
            }
            String token = makeToken();
            r.guest = new Side(token);
            r.hostReady = false;
            r.guestReady = false;
            JSONObject m = obj("from", "sys", "type", "sys", "event", "lobby");
            r.push(m);
            return Resp.json(200, obj("token", token, "seq", r.seq));
        }
    }

    private static Resp apiSend(String body) {
        JSONObject j;
        try {
            j = new JSONObject(body == null ? "{}" : body);
        } catch (Exception e) {
            return err(400, "bad json");
        }
        Room r = roomOf(j.optString("room", null));
        if (r == null) return err(404, "房间不存在");
        String side = r.sideOf(j.optString("token", ""));
        if (side == null) return err(403, "身份无效");
        JSONObject msg = j.optJSONObject("msg");
        synchronized (r) {
            if (msg != null && "bye".equals(msg.optString("type"))) {
                r.push(obj("from", side, "type", "bye"));
                r.set(side, null);
                return Resp.json(200, obj("ok", true));
            }
            r.touch(side);
            if (msg != null && "ready".equals(msg.optString("type"))) {
                boolean on = msg.optBoolean("on");
                if (on) {
                    if ("host".equals(side)) {
                        r.hostReady = true;
                        if (msg.has("firstOwner")) r.firstOwner = msg.opt("firstOwner");
                    } else {
                        r.guestReady = true;
                    }
                } else {
                    if ("host".equals(side)) r.hostReady = false; else r.guestReady = false;
                }
                r.push(obj("from", side, "type", "ready", "on", on));
                if (r.hostReady && r.guestReady) {
                    r.hostReady = false;
                    r.guestReady = false;
                    Object fo = r.firstOwner;
                    r.firstOwner = null;
                    int first = 1;
                    if (fo instanceof Integer) first = (Integer) fo;
                    else if (fo != null) {
                        try { first = Integer.parseInt(String.valueOf(fo)); } catch (Exception ignore) {}
                    }
                    r.push(obj("from", "sys", "type", "sys", "event", "start", "firstOwner", first));
                }
                return Resp.json(200, obj("ok", true));
            }
            JSONObject m = new JSONObject();
            try {
                if (msg != null) {
                    Iterator<String> it = msg.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        m.put(k, msg.opt(k));
                    }
                }
                m.put("from", side);
            } catch (Exception ignored) {}
            int id = r.push(m);
            return Resp.json(200, obj("ok", true, "id", id));
        }
    }

    private static Resp apiPoll(Map<String, String> q) {
        Room r = roomOf(q.get("room"));
        String token = q.get("token");
        int since = 0;
        try { since = Integer.parseInt(String.valueOf(q.get("since"))); } catch (Exception ignore) {}
        if (r == null) return Resp.json(200, obj("dead", true));
        String side = r.sideOf(token == null ? "" : token);
        if (side == null) return Resp.json(200, obj("dead", true));
        r.touch(side);
        String oppSide = "host".equals(side) ? "guest" : "host";
        Side opp = r.get(oppSide);
        String oppState = "none";
        if (opp != null) {
            oppState = (System.currentTimeMillis() - opp.touch > OFFLINE_AFTER) ? "offline" : "online";
        }
        JSONArray msgs = r.since(since, side);
        return Resp.json(200, obj("msgs", msgs, "opp", oppState));
    }

    /* ======================================================================
       内置 HTTP 监听（对外提供局域网联机 + 页面托管）
       ====================================================================== */
    public interface HtmlSource {
        byte[] html();
    }

    public static final class Listener {
        private final int port;
        private final HtmlSource source;
        private ServerSocket ss;
        private Thread acceptThread;
        private volatile boolean running;

        public Listener(int port, HtmlSource source) {
            this.port = port;
            this.source = source;
        }

        public synchronized boolean start() {
            if (running) return true;
            try {
                ss = new ServerSocket(port);
                ss.setReuseAddress(true);
            } catch (IOException e) {
                android.util.Log.e(TAG, "监听失败: " + e.getMessage());
                return false;
            }
            running = true;
            acceptThread = new Thread(new Runnable() {
                @Override public void run() {
                    while (running) {
                        try {
                            Socket s = ss.accept();
                            new Thread(new Conn(s)).start();
                        } catch (IOException e) {
                            if (running) android.util.Log.w(TAG, "accept: " + e.getMessage());
                        }
                    }
                }
            }, "g4-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            return true;
        }

        public synchronized void stop() {
            running = false;
            try { if (ss != null) ss.close(); } catch (IOException ignore) {}
            ss = null;
        }

        public boolean isRunning() { return running; }
        public int port() { return port; }

        private final class Conn implements Runnable {
            private final Socket s;
            Conn(Socket s) { this.s = s; }
            @Override public void run() {
                try {
                    s.setSoTimeout(15000);
                    BufferedInputStream in = new BufferedInputStream(s.getInputStream());
                    OutputStream out = s.getOutputStream();
                    boolean keep = true;
                    while (keep && running) {
                        String line = readLine(in);
                        if (line == null || line.isEmpty()) break;
                        String[] parts = line.split(" ");
                        if (parts.length < 2) break;
                        String method = parts[0];
                        String raw = parts[1];
                        int contentLen = 0;
                        keep = false;
                        String h;
                        while ((h = readLine(in)) != null && !h.isEmpty()) {
                            int c = h.indexOf(':');
                            if (c <= 0) continue;
                            String k = h.substring(0, c).trim().toLowerCase();
                            String v = h.substring(c + 1).trim();
                            if (k.equals("content-length")) {
                                try { contentLen = Integer.parseInt(v); } catch (Exception ignore) {}
                            } else if (k.equals("connection") && v.toLowerCase().contains("keep-alive")) {
                                keep = true;
                            }
                        }
                        String body = "";
                        if (contentLen > 0) {
                            byte[] b = new byte[contentLen];
                            int off = 0;
                            while (off < contentLen) {
                                int n = in.read(b, off, contentLen - off);
                                if (n < 0) break;
                                off += n;
                            }
                            body = new String(b, 0, off, StandardCharsets.UTF_8);
                        }
                        handle(out, method, raw, body, keep);
                    }
                } catch (IOException ignore) {
                } finally {
                    try { s.close(); } catch (IOException ignore) {}
                }
            }
        }

        private void handle(OutputStream out, String method, String raw, String body, boolean keep) throws IOException {
            String path = raw;
            Map<String, String> q = new HashMap<>();
            int qi = raw.indexOf('?');
            if (qi >= 0) {
                path = raw.substring(0, qi);
                for (String kv : raw.substring(qi + 1).split("&")) {
                    if (kv.isEmpty()) continue;
                    int e = kv.indexOf('=');
                    try {
                        if (e > 0) q.put(URLDecoder.decode(kv.substring(0, e), "UTF-8"),
                                URLDecoder.decode(kv.substring(e + 1), "UTF-8"));
                        else q.put(URLDecoder.decode(kv, "UTF-8"), "");
                    } catch (Exception ignore) {}
                }
            }
            try { path = URLDecoder.decode(path, "UTF-8"); } catch (Exception ignore) {}

            byte[] payload;
            String type;
            int status = 200;
            if (path.startsWith("/api/")) {
                Resp r = handleApi(method, path, q, body);
                status = r.status;
                type = r.type;
                payload = r.body.getBytes(StandardCharsets.UTF_8);
            } else if (path.equals("/") || path.equals("/index.html") || path.endsWith("重力四子棋.html")) {
                type = "text/html; charset=utf-8";
                payload = source.html();
            } else {
                status = 404;
                type = "text/plain; charset=utf-8";
                payload = "404".getBytes(StandardCharsets.UTF_8);
            }
            write(out, status, type, payload, keep);
        }

        private void write(OutputStream out, int status, String type, byte[] body, boolean keep) throws IOException {
            String reason = status == 200 ? "OK" : String.valueOf(status);
            StringBuilder h = new StringBuilder();
            h.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
            h.append("Content-Type: ").append(type).append("\r\n");
            h.append("Content-Length: ").append(body.length).append("\r\n");
            h.append("Cache-Control: no-store\r\n");
            h.append("Connection: ").append(keep ? "keep-alive" : "close").append("\r\n");
            h.append("\r\n");
            out.write(h.toString().getBytes(StandardCharsets.UTF_8));
            out.write(body);
            out.flush();
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') {
                if (sb.length() > 0 && sb.charAt(sb.length() - 1) == '\r') sb.setLength(sb.length() - 1);
                return sb.toString();
            }
            sb.append((char) c);
        }
        return sb.length() > 0 ? sb.toString() : null;
    }
}
