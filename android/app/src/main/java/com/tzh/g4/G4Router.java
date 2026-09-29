package com.tzh.g4;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/* ==========================================================================
   请求路由：把页面的 /api/* 请求送到正确的目的地
   --------------------------------------------------------------------------
   本机模式 → 直接调用 G4Server.handleApi（不经网络，零延迟）
   远端模式 → HttpURLConnection 转发到局域网内跑 node 服务器的机器
   status = 0 表示网络层失败，注入层会 reject，页面提示「无法连接服务器」
   ========================================================================== */
public final class G4Router {

    private G4Router() {}

    public static String pathOf(String url) {
        if (url == null) return "";
        String s = url;
        int i = s.indexOf('?');
        if (i >= 0) s = s.substring(0, i);
        i = s.indexOf('#');
        if (i >= 0) s = s.substring(0, i);
        if (s.matches("(?i)^https?://[^/]+/.*")) {
            s = s.replaceFirst("(?i)^https?://[^/]+", "");
        } else if (s.matches("(?i)^https?://[^/]+")) {
            s = "/";
        }
        return s;
    }

    public static Map<String, String> queryOf(String url) {
        Map<String, String> q = new HashMap<>();
        if (url == null) return q;
        int i = url.indexOf('?');
        if (i < 0) return q;
        String s = url.substring(i + 1);
        int h = s.indexOf('#');
        if (h >= 0) s = s.substring(0, h);
        for (String kv : s.split("&")) {
            if (kv.isEmpty()) continue;
            int e = kv.indexOf('=');
            if (e > 0) q.put(kv.substring(0, e), kv.substring(e + 1));
            else q.put(kv, "");
        }
        return q;
    }

    public static G4Server.Resp route(Context c, String method, String url, String body) {
        return route(c, method, url, body, 8000);
    }

    public static G4Server.Resp route(Context c, String method, String url, String body, int timeout) {
        if (Prefs.isLocal(c)) {
            return G4Server.handleApi(method, pathOf(url), queryOf(url), body);
        }
        String base = Prefs.remoteBase(c);
        if (base.isEmpty()) {
            return new G4Server.Resp(0, "未设置联机服务器地址", "text/plain");
        }
        return remote(base + url, method, body, timeout);
    }

    public static G4Server.Resp remote(String abs, String method, String body, int timeout) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(abs).openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(timeout);
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "application/json");
            boolean post = "POST".equalsIgnoreCase(method);
            if (post) {
                byte[] b = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setFixedLengthStreamingMode(b.length);
                OutputStream o = conn.getOutputStream();
                try { o.write(b); o.flush(); } finally { o.close(); }
            }
            int st = conn.getResponseCode();
            InputStream in = st >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : readAll(in);
            return new G4Server.Resp(st, text, "application/json");
        } catch (Exception e) {
            return new G4Server.Resp(0, String.valueOf(e.getMessage()), "text/plain");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static String readAll(InputStream in) {
        try {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return new String(o.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }
}
