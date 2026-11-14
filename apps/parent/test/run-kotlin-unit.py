#!/usr/bin/env python3
"""Compile the module's Android-free JVM tests using existing cached jars only.

Fallback for sandboxes where Gradle cannot create its home/daemon files.
This does not compile Android classes or replace the Android Gradle build gate.
"""
import os
import re
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
cache = Path(os.environ.get('GRADLE_USER_HOME', str(Path.home() / '.gradle'))) / 'caches/modules-2/files-2.1'

def jar(group, artifact, version):
    matches = sorted((cache / group / artifact / version).glob('*/*.jar'))
    if not matches:
        raise SystemExit(f'Missing cached dependency: {group}:{artifact}:{version}; no network download attempted')
    return str(matches[0])

stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.2.21')
annotations = jar('org.jetbrains', 'annotations', '13.0')
compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.2.21'), stdlib,
            jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.2.21'),
            jar('org.jetbrains.kotlin', 'kotlin-reflect', '2.2.10'),
            jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.10.2'), annotations]
classpath = [stdlib, annotations, jar('junit', 'junit', '4.13.2'), jar('org.hamcrest', 'hamcrest-core', '1.3'),
             jar('org.jetbrains.kotlinx', 'kotlinx-serialization-json-jvm', '1.6.3'),
             jar('org.jetbrains.kotlinx', 'kotlinx-serialization-core-jvm', '1.6.3')]
module = root / 'apps/parent/modules/sahaj-shield/android'
sources = sorted((module / 'src/main/java/app/sahaj/shield/core').glob('*.kt'))
sources += sorted((root / 'packages/shield-kotlin/src/main/kotlin').rglob('*.kt'))
tests = sorted((module / 'src/test/java/app/sahaj/shield/core').glob('*Test.kt'))
with tempfile.TemporaryDirectory(prefix='sahaj-c11-kotlin-') as output:
    subprocess.run(['java', '-cp', os.pathsep.join(compiler), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                    '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', os.pathsep.join(classpath),
                    '-d', output, *map(str, sources + tests)], check=True)
    subprocess.run(['java', f'-Dsahaj.rulesJson={root / "packages/shield/rules/rules.json"}',
                    f'-Dsahaj.pluginJs={root / "apps/parent/modules/sahaj-shield/app.plugin.js"}',
                    '-cp', os.pathsep.join([output, *classpath]), 'org.junit.runner.JUnitCore',
                    *[f'app.sahaj.shield.core.{name}' for test in tests for name in re.findall(r'^class (\w+)', test.read_text(), re.M)]], check=True)
