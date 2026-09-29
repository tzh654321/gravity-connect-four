package com.tzh.g4;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/* ==========================================================================
   资源加载：内置基线 + 外部覆盖（热更新）
   --------------------------------------------------------------------------
   加载优先级：内部 files/g4/<name>  >  assets/<name>
   内部覆盖文件由 App 内「导入 HTML」写入，或开发期通过 run-as 推送，
   因此更新游戏页面不需要重新打包 APK。
   ========================================================================== */
public final class G4Assets {

    public static final String GAME_HTML = "game.html";
    public static final String SHIM_JS = "g4-mobile.js";
    public static final String SETTINGS_JS = "g4-settings.js";

    private static final Pattern VIEWPORT =
            Pattern.compile("<meta\\s+name=[\"']viewport[\"'][^>]*>", Pattern.CASE_INSENSITIVE);

    private G4Assets() {}

    public static File overrideDir(Context c) {
        File d = new File(c.getFilesDir(), "g4");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    public static File overrideFile(Context c, String name) {
        return new File(overrideDir(c), name);
    }

    public static boolean hasOverride(Context c, String name) {
        File f = overrideFile(c, name);
        return f.isFile() && f.length() > 0;
    }

    private static String readAsset(Context c, String name) throws IOException {
        InputStream in = c.getAssets().open(name);
        try {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        return o.toByteArray();
    }

    public static String loadText(Context c, String name) {
        File f = overrideFile(c, name);
        if (f.isFile() && f.length() > 0) {
            try {
                byte[] b = readAll(new java.io.FileInputStream(f));
                return new String(b, StandardCharsets.UTF_8);
            } catch (IOException ignore) {
                /* 覆盖文件损坏则回退内置 */
            }
        }
        try {
            return readAsset(c, name);
        } catch (IOException e) {
            return "";
        }
    }

    public static void saveOverride(Context c, String name, String content) throws IOException {
        File d = overrideDir(c);
        if (!d.exists()) d.mkdirs();
        File tmp = new File(d, name + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        } finally {
            out.close();
        }
        File dst = new File(d, name);
        if (dst.exists()) dst.delete();
        if (!tmp.renameTo(dst)) throw new IOException("rename failed");
    }

    public static void clearOverride(Context c, String name) {
        File f = overrideFile(c, name);
        if (f.exists()) f.delete();
    }

    public static String shortHash(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (Exception e) {
            return "????????";
        }
    }

    /* 供 App 显示的来源说明 */
    public static String sourceLabel(Context c, String name) {
        return hasOverride(c, name) ? ("外部覆盖 · " + shortHash(loadText(c, name)))
                : ("内置基线 · " + shortHash(loadText(c, name)));
    }

    /* ----------------------------------------------------------------------
       组装页面：替换 viewport（安全区 + 禁用系统缩放）+ 注入适配层
       ---------------------------------------------------------------------- */
    public static byte[] buildPage(Context c) {
        String html = loadText(c, GAME_HTML);
        String shim = loadText(c, SHIM_JS);
        String settings = loadText(c, SETTINGS_JS);
        html = ensureViewport(html);
        html = injectShim(html, shim);
        html = injectShim(html, settings);
        return html.getBytes(StandardCharsets.UTF_8);
    }

    static String ensureViewport(String html) {
        String target = "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,"
                + "viewport-fit=cover,user-scalable=no,maximum-scale=1,minimum-scale=1\" />";
        Matcher m = VIEWPORT.matcher(html);
        if (m.find()) {
            return m.replaceFirst(Matcher.quoteReplacement(target));
        }
        int i = html.toLowerCase().indexOf("<head>");
        if (i >= 0) return html.substring(0, i + 6) + "\n" + target + html.substring(i + 6);
        return target + "\n" + html;
    }

    static String injectShim(String html, String shim) {
        if (shim == null || shim.isEmpty()) return html;
        String tag = "<script>\n" + shim + "\n</script>\n";
        /* 优先插到 </body> 前：保证 document.body 已解析、注入层可以挂 DOM */
        int i = html.toLowerCase().indexOf("</body>");
        if (i >= 0) return html.substring(0, i) + tag + html.substring(i);
        i = html.toLowerCase().indexOf("</head>");
        if (i >= 0) return html.substring(0, i) + tag + html.substring(i);
        i = html.toLowerCase().indexOf("<script");
        if (i >= 0) return html.substring(0, i) + tag + html.substring(i);
        i = html.toLowerCase().indexOf("<body>");
        if (i >= 0) return html.substring(0, i + 6) + tag + html.substring(i + 6);
        return tag + html;
    }
}
