#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""重力四子棋 APK 构建（无 Gradle）

流程：复制到 ASCII 工作目录 → aapt2 compile/link → javac → d8 → 打入 dex
      → zipalign → apksigner 签名 → 拷回项目 out 目录

为什么要 ASCII 工作目录：aapt2 与 zipalign 是原生程序，在 Windows 上
无法打开含非 ASCII 字符的路径（本项目路径含中文），因此全部编译动作
在 D:\\g4build 下完成，只有最终 APK 拷回项目目录（Java 工具支持中文路径）。

用法：
    python build.py                       # 默认 SDK/JDK
    python build.py --work E:\\tmp\\g4    # 指定工作目录
    python build.py --version-name 1.1.0 --version-code 2
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ANDROID = os.path.dirname(HERE)
ROOT = os.path.dirname(ANDROID)

DEFAULT_SDK = os.environ.get("ANDROID_HOME") or r"D:\Android\sdk"
DEFAULT_JDK = os.environ.get("JAVA_HOME") or r"D:\Program Files\Java\jdk-21"
# R8/D8 与 JDK 21 存在兼容 bug（匿名内部类 NPE），标准做法是用 JDK 17 运行
DEFAULT_JDK17 = r"D:\Download\_tools\jdk-17"

APP_NAME = "重力四子棋"
STORE_PASS = "g4g4g4"


def log(msg):
    print("[build] " + msg, flush=True)


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write("\n".join(filter(None, [r.stdout, r.stderr])))
        raise SystemExit("命令失败: " + " ".join(cmd[:4]))
    return r.stdout


class Builder:
    def __init__(self, sdk, jdk, version_name, version_code, work, jdk17=None):
        self.sdk = sdk
        self.jdk = jdk
        self.jdk17 = jdk17 or DEFAULT_JDK17
        self.ver_name = version_name
        self.ver_code = version_code
        self.work = work or self.default_work()

        self.bt = os.path.join(sdk, "build-tools", "34.0.0")
        self.platform_jar = os.path.join(sdk, "platforms", "android-34", "android.jar")
        self.aapt2 = os.path.join(self.bt, "aapt2.exe")
        self.zipalign = os.path.join(self.bt, "zipalign.exe")
        self.d8_jar = os.path.join(self.bt, "lib", "d8.jar")
        self.apksigner = os.path.join(self.bt, "lib", "apksigner.jar")
        self.java = os.path.join(jdk, "bin", "java.exe")
        self.javac = os.path.join(jdk, "bin", "javac.exe")
        self.keytool = os.path.join(jdk, "bin", "keytool.exe")

        # 重要：JDK 21 的 javac 即使 --release 8 生成匿名内部类 class 文件，
        # 也会触发 build-tools 34 自带 R8/D8 的 NPE（已验证）。必须整个工具链
        # 使用 JDK 17 编译与 dex。
        j17bin = os.path.join(self.jdk17, "bin")
        if os.path.isfile(os.path.join(j17bin, "java.exe")):
            self.java = os.path.join(j17bin, "java.exe")
            self.javac = os.path.join(j17bin, "javac.exe")
            self.keytool = os.path.join(j17bin, "keytool.exe")
            self.toolchain = "JDK17 (" + self.jdk17 + ")"
        else:
            self.toolchain = "JDK21 (fallback; R8 存在已知 NPE)"

        self.src = os.path.join(ANDROID, "app", "src", "main")   # 源码（可能含中文路径）
        self.inject = os.path.join(ANDROID, "inject")
        self.wsrc = os.path.join(self.work, "app", "src", "main")  # 工作副本（纯 ASCII）
        self.build_dir = os.path.join(self.work, "build")
        self.out = os.path.join(ANDROID, "out")
        self.keystore = os.path.join(ANDROID, "g4.keystore")

    @staticmethod
    def default_work():
        drive = os.path.splitdrive(ANDROID)[0] or "C:"
        return os.path.join(drive + os.sep, "g4build")

    def check(self):
        for p in (self.aapt2, self.platform_jar, self.java, self.javac,
                  self.d8_jar, self.apksigner, self.zipalign):
            if not os.path.isfile(p):
                raise SystemExit("缺少工具: " + p)

    def prepare_work(self):
        """把源码与资源覆盖复制到 ASCII 工作目录，并生成 assets

        这里刻意不做整目录删除：工作目录与构建目录都采用覆盖式更新，
        既避开沙箱对批量删除的限制，也让重复构建保持幂等。
        """
        os.makedirs(os.path.dirname(self.wsrc), exist_ok=True)
        shutil.copytree(self.src, self.wsrc, dirs_exist_ok=True)

        assets = os.path.join(self.wsrc, "assets")
        os.makedirs(assets, exist_ok=True)

        game = os.path.join(ROOT, "index.html")
        if not os.path.isfile(game):
            raise SystemExit("未找到游戏页面: " + game)
        shutil.copy2(game, os.path.join(assets, "game.html"))
        n = 0
        for js in sorted(glob.glob(os.path.join(self.inject, "*.js"))):
            shutil.copy2(js, os.path.join(assets, os.path.basename(js)))
            n += 1
        os.makedirs(self.build_dir, exist_ok=True)
        os.makedirs(self.out, exist_ok=True)
        log("工作目录就绪：%s（game.html + %d 个注入脚本）" % (self.work, n))

    def aapt(self):
        res = os.path.join(self.wsrc, "res")
        res_zip = os.path.join(self.build_dir, "res.zip")
        run([self.aapt2, "compile", "--dir", res, "-o", res_zip])
        unsigned = os.path.join(self.build_dir, "unsigned.apk")
        self.gen = os.path.join(self.build_dir, "gen")
        os.makedirs(self.gen, exist_ok=True)
        run([self.aapt2, "link",
             "-I", self.platform_jar,
             "--manifest", os.path.join(self.wsrc, "AndroidManifest.xml"),
             "-A", os.path.join(self.wsrc, "assets"),
             "--java", self.gen,
             "-o", unsigned,
             "--min-sdk-version", "26",
             "--target-sdk-version", "34",
             "--version-code", str(self.ver_code),
             "--version-name", self.ver_name,
             res_zip])
        log("资源编译完成")
        return unsigned

    def compile_java(self):
        classes = os.path.join(self.build_dir, "classes")
        os.makedirs(classes, exist_ok=True)
        for stale in glob.glob(os.path.join(classes, "**", "*.class"), recursive=True):
            try:
                os.remove(stale)
            except OSError:
                pass
        files = glob.glob(os.path.join(self.wsrc, "java", "**", "*.java"), recursive=True)
        r_java = glob.glob(os.path.join(self.gen, "**", "*.java"), recursive=True)
        files += r_java
        if not files:
            raise SystemExit("没有 Java 源文件")
        # 目标字节码定为 Java 8：build-tools 34 自带的 d8 在处理 JDK 21 生成的
        # 高版本 class（特别是匿名内部类）时会抛 NullPointerException
        run([self.javac, "-nowarn", "-encoding", "UTF-8", "--release", "8",
             "-classpath", self.platform_jar, "-d", classes] + files)
        cls = glob.glob(os.path.join(classes, "**", "*.class"), recursive=True)
        log("Java 编译完成：%d 源文件 → %d class" % (len(files), len(cls)))
        return classes

    def dex(self, classes):
        cls = glob.glob(os.path.join(classes, "**", "*.class"), recursive=True)
        run([self.java, "-cp", self.d8_jar, "com.android.tools.r8.D8",
             "--lib", self.platform_jar, "--min-api", "26",
             "--output", self.build_dir] + cls)
        dex = os.path.join(self.build_dir, "classes.dex")
        if not os.path.isfile(dex):
            raise SystemExit("d8 未产出 classes.dex")
        log("DEX 生成完成：%.1f KB" % (os.path.getsize(dex) / 1024.0))
        return dex

    @staticmethod
    def add_dex(apk, dex):
        """dex 必须以 STORED 方式存放，否则 Android 拒绝加载"""
        with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
            if "classes.dex" in z.namelist():
                raise SystemExit("apk 中已存在 classes.dex")
            with open(dex, "rb") as f:
                z.writestr(zipfile.ZipInfo("classes.dex"), f.read(),
                           compress_type=zipfile.ZIP_STORED)
        log("已写入 classes.dex")

    def align(self, src):
        dst = os.path.join(self.build_dir, "aligned.apk")
        run([self.zipalign, "-f", "4", src, dst])
        return dst

    def ensure_keystore(self):
        if os.path.isfile(self.keystore):
            return
        run([self.keytool, "-genkeypair", "-v",
             "-keystore", self.keystore, "-alias", "g4",
             "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
             "-storepass", STORE_PASS, "-keypass", STORE_PASS,
             "-dname", "CN=g4, OU=g4, O=g4, L=CN, S=CN, C=CN"])
        log("已生成签名密钥: " + self.keystore)

    def sign(self, aligned):
        self.ensure_keystore()
        out = os.path.join(self.out, "%s-v%s.apk" % (APP_NAME, self.ver_name))
        if os.path.isfile(out):
            try:
                os.remove(out)
            except OSError:
                pass
        run([self.java, "-jar", self.apksigner, "sign",
             "--ks", self.keystore, "--ks-key-alias", "g4",
             "--ks-pass", "pass:" + STORE_PASS, "--key-pass", "pass:" + STORE_PASS,
             "--min-sdk-version", "26", "--out", out, aligned])
        log("签名完成")
        return out

    def build(self):
        self.check()
        self.prepare_work()
        apk = self.aapt()
        classes = self.compile_java()
        dex = self.dex(classes)
        self.add_dex(apk, dex)
        aligned = self.align(apk)
        final = self.sign(aligned)
        log("构建成功 → %s（%.0f KB）" % (final, os.path.getsize(final) / 1024.0))
        return final


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sdk", default=DEFAULT_SDK)
    ap.add_argument("--jdk", default=DEFAULT_JDK)
    ap.add_argument("--work", default=None)
    ap.add_argument("--jdk17", default=DEFAULT_JDK17)
    ap.add_argument("--version-name", default="1.0.0")
    ap.add_argument("--version-code", type=int, default=1)
    a = ap.parse_args()
    Builder(a.sdk, a.jdk, a.version_name, a.version_code, a.work, a.jdk17).build()


if __name__ == "__main__":
    main()
