package com.tzh.g4;

import android.content.Context;
import android.content.SharedPreferences;

/* 设置存储：联机模式、服务器地址、端口、显示与保活开关 */
public final class Prefs {

    private static final String FILE = "g4";
    private static final String K_MODE = "mode";           // local | remote
    private static final String K_BASE = "remote_base";
    private static final String K_PORT = "port";
    private static final String K_SCREEN = "keep_screen";
    private static final String K_TAP = "tap_to_place";
    private static final String K_ALIVE = "keep_alive";
    private static final String K_LAST_IP = "last_remote";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static boolean isLocal(Context c) {
        return !"remote".equals(sp(c).getString(K_MODE, "local"));
    }

    public static void setLocal(Context c, boolean local) {
        sp(c).edit().putString(K_MODE, local ? "local" : "remote").apply();
    }

    /* 规范化用户输入：补 http:// 与默认端口，去掉结尾斜杠 */
    public static String normalizeBase(String s) {
        if (s == null) return "";
        String v = s.trim();
        if (v.isEmpty()) return "";
        if (!v.matches("(?i)^https?://.*")) v = "http://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        if (!v.matches("^https?://[^/]+:\\d+.*")) v = v + ":8765";
        return v;
    }

    public static String remoteBase(Context c) {
        String v = sp(c).getString(K_BASE, "");
        return v.isEmpty() ? "" : normalizeBase(v);
    }

    public static void setRemoteBase(Context c, String s) {
        sp(c).edit().putString(K_BASE, s == null ? "" : s.trim()).apply();
    }

    public static String lastRemote(Context c) {
        return sp(c).getString(K_LAST_IP, "");
    }

    public static int port(Context c) {
        int p = sp(c).getInt(K_PORT, 8765);
        if (p < 1024 || p > 65535) p = 8765;
        return p;
    }

    public static void setPort(Context c, int p) {
        if (p < 1024 || p > 65535) p = 8765;
        sp(c).edit().putInt(K_PORT, p).apply();
    }

    public static boolean keepScreen(Context c) {
        return sp(c).getBoolean(K_SCREEN, true);
    }

    public static void setKeepScreen(Context c, boolean v) {
        sp(c).edit().putBoolean(K_SCREEN, v).apply();
    }

    public static boolean tapToPlace(Context c) {
        return sp(c).getBoolean(K_TAP, false);
    }

    public static void setTapToPlace(Context c, boolean v) {
        sp(c).edit().putBoolean(K_TAP, v).apply();
    }

    public static boolean keepAlive(Context c) {
        return sp(c).getBoolean(K_ALIVE, true);
    }

    public static void setKeepAlive(Context c, boolean v) {
        sp(c).edit().putBoolean(K_ALIVE, v).apply();
    }
}
