#!/usr/bin/env python3
"""Merges the manifests of library AARs into the app manifest, the way Gradle's merger does for the
cases DriveMate's libraries use: components with the same android:name are combined (their child
<meta-data> lists joined), new components and permissions are added, ${applicationId} is filled in.
Usage: merge-manifest.py app.xml out.xml lib1.xml lib2.xml ..."""
import sys, xml.etree.ElementTree as ET
A = "{http://schemas.android.com/apk/res/android}"
T = "{http://schemas.android.com/tools}"
ET.register_namespace("android", A[1:-1]); ET.register_namespace("tools", T[1:-1])

app_path, out_path, libs = sys.argv[1], sys.argv[2], sys.argv[3:]
tree = ET.parse(app_path); root = tree.getroot(); pkg = root.get("package")
application = root.find("application")
key = lambda e: (e.tag, e.get(A + "name"))
# Library components the app manifest removes with tools:node="remove" (Gradle's convention).
removed = set()
for e in list(root.iter()):
    for c in list(e):
        if c.get(T + "node") == "remove": removed.add(key(c)); e.remove(c)

def strip_tools(e):
    for k in [k for k in e.attrib if k.startswith(T)]: del e.attrib[k]
    for c in e: strip_tools(c)

def fill(e):
    for k, v in e.attrib.items():
        if "${applicationId}" in v: e.set(k, v.replace("${applicationId}", pkg))
    for c in e: fill(c)

def merge_into(parent, child):
    if key(child) in removed: return
    for existing in parent:
        if key(existing) == key(child) and child.get(A + "name"):
            for k, v in child.attrib.items(): existing.attrib.setdefault(k, v)
            for gc in child: merge_into(existing, gc)
            return
    parent.append(child)

for path in libs:
    lib = ET.parse(path).getroot()
    if lib.get(T + "node") == "remove": continue
    strip_tools(lib); fill(lib)
    for e in lib:
        if e.tag in ("uses-permission", "uses-permission-android:maxSdkVersion", "uses-feature", "permission"):
            merge_into(root, e)
        elif e.tag == "queries":
            q = root.find("queries")
            if q is None: root.insert(0, e)
            else: [merge_into(q, c) for c in e]
    la = lib.find("application")
    if la is not None:
        for c in la: merge_into(application, c)

# Permissions must come before <application>.
for e in [e for e in root if e.tag in ("uses-permission", "permission", "uses-feature")]:
    root.remove(e); root.insert(0, e)
tree.write(out_path, encoding="utf-8", xml_declaration=True)
