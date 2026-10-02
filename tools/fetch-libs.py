#!/usr/bin/env python3
"""Downloads the Android libraries DriveMate needs (and everything they depend on) into libs/.
No Gradle: reads the Maven POMs directly. Where two libraries ask for different versions of the
same dependency, the highest wins, like Gradle. Run again after changing ROOTS."""
import os, re, sys, urllib.request, xml.etree.ElementTree as ET

ROOTS = ["com.google.android.gms:play-services-mlkit-text-recognition:19.0.1"]
REPOS = ["https://dl.google.com/dl/android/maven2", "https://repo1.maven.org/maven2"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "libs")
NS = "{http://maven.apache.org/POM/4.0.0}"
SKIP = {"org.jetbrains:annotations", "com.google.errorprone:error_prone_annotations", "com.google.code.findbugs:jsr305",
        "org.checkerframework:checker-qual", "com.google.j2objc:j2objc-annotations"}  # compile-time annotations only

def get(path):
    for r in REPOS:
        try:
            with urllib.request.urlopen(f"{r}/{path}", timeout=60) as f: return f.read()
        except Exception: pass
    return None

def vkey(v): return [int(x) if x.isdigit() else x for x in re.split(r"[.\-]", v)]
def clean(v): return v.strip("[]()").split(",")[0].strip()

poms, best = {}, {}
def pom(g, a, v):
    k = (g, a, v)
    if k not in poms:
        data = get(f"{g.replace('.', '/')}/{a}/{v}/{a}-{v}.pom")
        poms[k] = ET.fromstring(data) if data else None
    return poms[k]

def deps(g, a, v):
    root = pom(g, a, v)
    if root is None: return [], "jar"
    packaging = (root.findtext(f"{NS}packaging") or "jar").strip()
    props = {p.tag.replace(NS, ""): (p.text or "") for p in root.findall(f"{NS}properties/*")}
    out = []
    for d in root.findall(f"{NS}dependencies/{NS}dependency"):
        scope = (d.findtext(f"{NS}scope") or "compile").strip()
        if scope not in ("compile", "runtime") or (d.findtext(f"{NS}optional") or "") == "true": continue
        dg, da, dv = ((d.findtext(f"{NS}{t}") or "").strip() for t in ("groupId", "artifactId", "version"))
        dv = re.sub(r"\$\{([^}]+)\}", lambda m: props.get(m.group(1), "") or v, dv)
        if dg and da and dv: out.append((dg, da, clean(dv)))
    return out, packaging

queue = [tuple(c.split(":")) for c in ROOTS]
while queue:
    g, a, v = queue.pop()
    if f"{g}:{a}" in SKIP: continue
    if (g, a) in best and vkey(best[(g, a)][0]) >= vkey(v): continue
    ds, packaging = deps(g, a, v)
    best[(g, a)] = (v, packaging)
    queue.extend(ds)

os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT): os.remove(os.path.join(OUT, f))
for (g, a), (v, packaging) in sorted(best.items()):
    for ext in (["aar", "jar"] if packaging != "jar" else ["jar", "aar"]):
        data = get(f"{g.replace('.', '/')}/{a}/{v}/{a}-{v}.{ext}")
        if data:
            open(os.path.join(OUT, f"{g}__{a}__{v}.{ext}"), "wb").write(data)
            print(f"{g}:{a}:{v} ({ext}, {len(data)//1024} KB)")
            break
    else:
        print(f"MISSING {g}:{a}:{v}", file=sys.stderr)
