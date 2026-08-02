"""Deterministic local fixtures for V1 stack acceptance.

These fixtures validate a real compiler/runtime path.  They intentionally do
not substitute one technology for another: a capability without its native
fixture or toolchain remains unverified.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StackFixture:
    files: dict[str, str]
    commands: tuple[tuple[str, ...], ...]
    environment: dict[str, str] | None = None
    timeout_seconds: int | None = None


_PYTHON_FILES = {
    "calculator.py": "def add(left: int, right: int) -> int:\n    return left + right\n",
    "test_calculator.py": (
        "from calculator import add\n\n"
        "def test_add():\n"
        "    assert add(20, 22) == 42\n"
    ),
}

_NODE_FILES = {
    "math.js": "export function add(left, right) { return left + right; }\n",
    "math.test.js": (
        "import test from 'node:test';\n"
        "import assert from 'node:assert/strict';\n"
        "import { add } from './math.js';\n"
        "test('adds', () => assert.equal(add(20, 22), 42));\n"
    ),
    "package.json": (
        '{"private":true,"type":"module","scripts":{"test":"node --test math.test.js"}}\n'
    ),
}

_MAVEN_JUNIT_FILES = {
    "pom.xml": (
        '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
        "  <modelVersion>4.0.0</modelVersion>\n"
        "  <groupId>dev.arforge.acceptance</groupId>\n"
        "  <artifactId>junit-fixture</artifactId><version>1.0.0</version>\n"
        "  <properties><maven.compiler.release>17</maven.compiler.release>"
        "<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>"
        "<junit.version>5.11.4</junit.version></properties>\n"
        "  <dependencies><dependency><groupId>org.junit.jupiter</groupId>"
        "<artifactId>junit-jupiter</artifactId><version>${junit.version}</version>"
        "<scope>test</scope></dependency></dependencies>\n"
        "  <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId>"
        "<artifactId>maven-surefire-plugin</artifactId><version>3.5.2</version>"
        "</plugin></plugins></build>\n"
        "</project>\n"
    ),
    "src/main/java/dev/arforge/Calculator.java": (
        "package dev.arforge;\n"
        "public final class Calculator {\n"
        "  private Calculator() {}\n"
        "  public static int add(int left, int right) { return left + right; }\n"
        "}\n"
    ),
    "src/test/java/dev/arforge/CalculatorTest.java": (
        "package dev.arforge;\n"
        "import static org.junit.jupiter.api.Assertions.assertEquals;\n"
        "import org.junit.jupiter.api.Test;\n"
        "final class CalculatorTest {\n"
        "  @Test void adds() { assertEquals(42, Calculator.add(20, 22)); }\n"
        "}\n"
    ),
}

_GITHUB_WORKFLOW_FILES = {
    ".github/workflows/ci.yml": (
        "name: CI\n"
        "on: [push, pull_request]\n"
        "jobs:\n"
        "  test:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - uses: actions/checkout@v4\n"
        "      - uses: actions/setup-python@v5\n"
        "        with:\n"
        "          python-version: '3.12'\n"
        "      - run: python pipeline.py\n"
    ),
    "pipeline.py": (
        "from pathlib import Path\n"
        "import yaml\n"
        "workflow = yaml.safe_load(Path('.github/workflows/ci.yml').read_text())\n"
        "assert workflow['jobs']['test']['runs-on'] == 'ubuntu-latest'\n"
        "assert len(workflow['jobs']['test']['steps']) == 3\n"
        "print('PASS')\n"
    ),
}

_GO_FILES = {
    "go.mod": "module example.com/arforge/acceptance\n\ngo 1.24\n",
    "calculator.go": (
        "package acceptance\n\n"
        "func Add(left, right int) int { return left + right }\n"
    ),
    "calculator_test.go": (
        "package acceptance\n\n"
        'import "testing"\n\n'
        "func TestAdd(t *testing.T) {\n"
        '  if Add(20, 22) != 42 { t.Fatal("add") }\n'
        "}\n"
    ),
}


def _docker(image: str, *command: str) -> tuple[str, ...]:
    return (
        "docker",
        "run",
        "--rm",
        "-v",
        "{workspace}:/work",
        "-w",
        "/work",
        image,
        *command,
    )


def _gradle_docker(*command: str) -> tuple[str, ...]:
    return (
        "docker",
        "run",
        "--rm",
        "-v",
        "{workspace}:/work",
        "-v",
        "arforge-stack-gradle-cache:/home/gradle/.gradle",
        "-w",
        "/work",
        "gradle:8.14-jdk21-alpine",
        *command,
    )


FIXTURES: dict[str, StackFixture] = {
    "lang-python": StackFixture(
        files=_PYTHON_FILES,
        commands=(("{python}", "-m", "pytest", "-q"),),
    ),
    "lang-java": StackFixture(
        files={
            "Main.java": (
                "public final class Main {\n"
                "  static int add(int a, int b) { return a + b; }\n"
                "  public static void main(String[] args) {\n"
                '    if (add(20, 22) != 42) throw new AssertionError("add");\n'
                '    System.out.println("PASS");\n'
                "  }\n"
                "}\n"
            )
        },
        commands=(("javac", "Main.java"), ("java", "Main")),
    ),
    "lang-javascript": StackFixture(
        files=_NODE_FILES,
        commands=(("node", "--test", "math.test.js"),),
    ),
    "lang-typescript": StackFixture(
        files={
            "main.ts": (
                "export function add(left: number, right: number): number {\n"
                "  return left + right;\n"
                "}\n"
                "if (add(20, 22) !== 42) throw new Error('add');\n"
            )
        },
        commands=(
            (
                "npx",
                "--yes",
                "--package",
                "typescript",
                "tsc",
                "main.ts",
                "--strict",
                "--noEmit",
            ),
        ),
    ),
    "lang-c": StackFixture(
        files={
            "main.c": (
                "#include <assert.h>\n"
                "#include <stdio.h>\n"
                "static int add(int a, int b) { return a + b; }\n"
                'int main(void) { assert(add(20, 22) == 42); puts("PASS"); return 0; }\n'
            )
        },
        commands=(("gcc", "main.c", "-Wall", "-Wextra", "-Werror", "-o", "app.exe"), ("app.exe",)),
    ),
    "lang-cpp": StackFixture(
        files={
            "main.cpp": (
                "#include <cassert>\n"
                "#include <iostream>\n"
                "constexpr int add(int a, int b) { return a + b; }\n"
                'int main() { assert(add(20, 22) == 42); std::cout << "PASS\\n"; }\n'
            )
        },
        commands=(("g++", "main.cpp", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-o", "app.exe"), ("app.exe",)),
    ),
    "lang-csharp": StackFixture(
        files={
            "Acceptance.csproj": (
                '<Project Sdk="Microsoft.NET.Sdk">\n'
                "  <PropertyGroup><OutputType>Exe</OutputType>"
                "<TargetFramework>{dotnet_target}</TargetFramework>"
                "<ImplicitUsings>enable</ImplicitUsings>"
                "<Nullable>enable</Nullable></PropertyGroup>\n"
                "</Project>\n"
            ),
            "Program.cs": (
                "static int Add(int left, int right) => left + right;\n"
                'if (Add(20, 22) != 42) throw new Exception("add");\n'
                'Console.WriteLine("PASS");\n'
            ),
        },
        commands=(("dotnet", "run", "--project", "Acceptance.csproj"),),
    ),
    "lang-go": StackFixture(
        files=_GO_FILES,
        commands=(_docker("golang:1.24-alpine", "go", "test", "./..."),),
    ),
    "lang-rust": StackFixture(
        files={
            "main.rs": (
                "fn add(left: i32, right: i32) -> i32 { left + right }\n"
                'fn main() { assert_eq!(add(20, 22), 42); println!("PASS"); }\n'
            )
        },
        commands=(("rustc", "main.rs", "-D", "warnings", "-o", "app.exe"), ("app.exe",)),
    ),
    "lang-php": StackFixture(
        files={
            "acceptance.php": (
                "<?php\n"
                "function add(int $left, int $right): int { return $left + $right; }\n"
                "assert(add(20, 22) === 42);\n"
                'echo "PASS\\n";\n'
            )
        },
        commands=(_docker("php:8.4-cli-alpine", "php", "-d", "zend.assertions=1", "acceptance.php"),),
    ),
    "lang-ruby": StackFixture(
        files={
            "acceptance.rb": (
                "def add(left, right)\n  left + right\nend\n"
                "raise 'add' unless add(20, 22) == 42\n"
                "puts 'PASS'\n"
            )
        },
        commands=(_docker("ruby:3.4-alpine", "ruby", "acceptance.rb"),),
    ),
    "lang-kotlin": StackFixture(
        files={
            "settings.gradle.kts": 'rootProject.name = "arforge-acceptance"\n',
            "build.gradle.kts": (
                'plugins { kotlin("jvm") version "2.1.20" }\n'
                "repositories { mavenCentral() }\n"
                "dependencies { testImplementation(kotlin(\"test\")) }\n"
                "tasks.test { useJUnitPlatform() }\n"
            ),
            "src/main/kotlin/Calculator.kt": (
                "fun add(left: Int, right: Int): Int = left + right\n"
            ),
            "src/test/kotlin/CalculatorTest.kt": (
                "import kotlin.test.Test\nimport kotlin.test.assertEquals\n"
                "class CalculatorTest { @Test fun adds() { assertEquals(42, add(20, 22)) } }\n"
            ),
        },
        commands=(
            _gradle_docker(
                "gradle",
                "test",
                "--no-daemon",
                "--console=plain",
            ),
        ),
        timeout_seconds=600,
    ),
    "lang-swift": StackFixture(
        files={
            "acceptance.swift": (
                "func add(_ left: Int, _ right: Int) -> Int { left + right }\n"
                'precondition(add(20, 22) == 42, "add")\n'
                'print("PASS")\n'
            )
        },
        commands=(_docker("swift:6.1-noble", "swift", "acceptance.swift"),),
    ),
    "lang-sql": StackFixture(
        files={
            "acceptance.sql": (
                "CREATE TABLE totals(value INTEGER NOT NULL);\n"
                "INSERT INTO totals VALUES (42);\n"
                "SELECT CASE WHEN SUM(value)=42 THEN 'PASS' ELSE 'FAIL' END FROM totals;\n"
            )
        },
        commands=(("sqlite3", ":memory:", ".read acceptance.sql"),),
    ),
    "lang-shell": StackFixture(
        files={
            "acceptance.sh": (
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                'value=$((20 + 22))\n'
                'test "$value" -eq 42\n'
                'printf "PASS\\n"\n'
            )
        },
        commands=(("bash", "acceptance.sh"),),
    ),
    "framework-flask": StackFixture(
        files={
            "acceptance.py": (
                "from flask import Flask, jsonify\n"
                "app = Flask(__name__)\n"
                "@app.get('/health')\n"
                "def health(): return jsonify(status='ok')\n"
                "response = app.test_client().get('/health')\n"
                "assert response.status_code == 200\n"
                "assert response.get_json() == {'status': 'ok'}\n"
                "print('PASS')\n"
            )
        },
        commands=(("{python}", "acceptance.py"),),
    ),
    "framework-django": StackFixture(
        files={
            "acceptance.py": (
                "from django.conf import settings\n"
                "if not settings.configured:\n"
                "    settings.configure(ROOT_URLCONF=__name__, SECRET_KEY='acceptance', "
                "ALLOWED_HOSTS=['testserver'])\n"
                "import django\n"
                "django.setup()\n"
                "from django.http import JsonResponse\n"
                "from django.urls import path\n"
                "from django.test import Client\n"
                "def health(_request): return JsonResponse({'status': 'ok'})\n"
                "urlpatterns = [path('health/', health)]\n"
                "response = Client().get('/health/')\n"
                "assert response.status_code == 200\n"
                "assert response.json() == {'status': 'ok'}\n"
                "print('PASS')\n"
            )
        },
        commands=(
            ("{python}", "-m", "venv", ".venv"),
            ("{venv_python}", "-m", "pip", "install", "Django==5.2.5", "--quiet"),
            ("{venv_python}", "acceptance.py"),
        ),
    ),
    "framework-fastapi": StackFixture(
        files={
            "acceptance.py": (
                "import asyncio\n"
                "from fastapi import FastAPI\n"
                "app = FastAPI()\n"
                "@app.get('/health')\n"
                "async def health(): return {'status': 'ok'}\n"
                "route = next(r for r in app.routes if getattr(r, 'path', '') == '/health')\n"
                "assert asyncio.run(route.endpoint()) == {'status': 'ok'}\n"
                "print('PASS')\n"
            )
        },
        commands=(("{python}", "acceptance.py"),),
    ),
    "framework-node": StackFixture(
        files=_NODE_FILES,
        commands=(("node", "--test", "math.test.js"),),
    ),
    "framework-express": StackFixture(
        files={
            "package.json": '{"private":true,"type":"module"}\n',
            "acceptance.mjs": (
                "import express from 'express';\n"
                "const app = express();\n"
                "app.get('/health', (_req, res) => res.json({status:'ok'}));\n"
                "const server = app.listen(0, '127.0.0.1');\n"
                "await new Promise(resolve => server.once('listening', resolve));\n"
                "const {port} = server.address();\n"
                "const response = await fetch(`http://127.0.0.1:${port}/health`);\n"
                "const body = await response.json();\n"
                "server.close();\n"
                "if (!response.ok || body.status !== 'ok') throw new Error('health');\n"
                "console.log('PASS');\n"
            ),
        },
        commands=(
            ("npm", "install", "express@5.1.0", "--no-audit", "--no-fund", "--silent"),
            ("node", "acceptance.mjs"),
        ),
    ),
    "framework-vue": StackFixture(
        files={
            "package.json": '{"private":true,"type":"module"}\n',
            "acceptance.mjs": (
                "import {createSSRApp, h} from 'vue';\n"
                "import {renderToString} from '@vue/server-renderer';\n"
                "const app = createSSRApp({render:()=>h('main', {id:'app'}, 'Arforge')});\n"
                "const html = await renderToString(app);\n"
                "if (!html.includes('Arforge') || !html.includes('id=\"app\"')) throw new Error(html);\n"
                "console.log('PASS');\n"
            ),
        },
        commands=(
            (
                "npm",
                "install",
                "vue@3.5.18",
                "@vue/server-renderer@3.5.18",
                "--no-audit",
                "--no-fund",
                "--silent",
            ),
            ("node", "acceptance.mjs"),
        ),
    ),
    "framework-react": StackFixture(
        files={
            "package.json": '{"private":true,"type":"module"}\n',
            "acceptance.mjs": (
                "import React from 'react';\n"
                "import {renderToStaticMarkup} from 'react-dom/server';\n"
                "const html = renderToStaticMarkup(React.createElement('main', {id:'app'}, 'Arforge'));\n"
                "if (html !== '<main id=\"app\">Arforge</main>') throw new Error(html);\n"
                "console.log('PASS');\n"
            ),
        },
        commands=(
            (
                "npm",
                "install",
                "react@19.1.1",
                "react-dom@19.1.1",
                "--no-audit",
                "--no-fund",
                "--silent",
            ),
            ("node", "acceptance.mjs"),
        ),
    ),
    "framework-angular": StackFixture(
        files={"README.txt": "Angular production build fixture.\n"},
        commands=(
            (
                "npx",
                "--yes",
                "--package",
                "@angular/cli@20.1.6",
                "ng",
                "new",
                "app",
                "--minimal",
                "--defaults",
                "--skip-git",
                "--skip-install",
                "--routing=false",
                "--style=css",
            ),
            ("npm", "--prefix", "app", "install", "--no-audit", "--no-fund", "--silent"),
            ("npm", "--prefix", "app", "run", "build", "--silent"),
        ),
    ),
    "framework-electron": StackFixture(
        files={
            "prepare.py": (
                "from hashlib import sha256\n"
                "from pathlib import Path\n"
                "from urllib.request import urlretrieve\n"
                "from zipfile import ZipFile\n"
                "url = ('https://npmmirror.com/mirrors/electron/37.2.6/'\n"
                "       'electron-v37.2.6-win32-x64.zip')\n"
                "archive = Path('electron.zip')\n"
                "urlretrieve(url, archive)\n"
                "observed = sha256(archive.read_bytes()).hexdigest()\n"
                "expected = 'f7732d90dc70b9c7415a06f97f47f1ad45af8d6d89f557f6b00cee613f9a508e'\n"
                "assert observed == expected, (observed, expected)\n"
                "with ZipFile(archive) as package: package.extractall('electron-dist')\n"
            ),
            "acceptance.cjs": (
                "if (!process.versions.electron) throw new Error('not Electron');\n"
                "if (20 + 22 !== 42) throw new Error('add');\n"
                "console.log(`PASS Electron ${process.versions.electron}`);\n"
            ),
            "verify.cjs": (
                "const {execFileSync} = require('node:child_process');\n"
                "const path = require('node:path');\n"
                "const electron = path.join(__dirname, 'electron-dist', 'electron.exe');\n"
                "const output = execFileSync(electron, ['acceptance.cjs'], {\n"
                "  cwd: __dirname,\n"
                "  env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},\n"
                "  encoding: 'utf8'\n"
                "});\n"
                "if (!output.includes('PASS Electron')) throw new Error(output);\n"
                "console.log(output.trim());\n"
            ),
        },
        commands=(
            ("{python}", "prepare.py"),
            ("node", "verify.cjs"),
        ),
    ),
    "framework-tauri": StackFixture(
        files={
            "Cargo.toml": (
                "[package]\nname='arforge-tauri-acceptance'\nversion='0.1.0'\nedition='2021'\n"
                "[dependencies]\ntauri = { version = '2.8.2', features = [] }\n"
            ),
            "src/main.rs": (
                "fn main() {\n"
                "  let _builder = tauri::Builder::<tauri::Wry>::default();\n"
                '  println!("PASS");\n'
                "}\n"
            ),
            "tauri.conf.json": (
                '{"$schema":"https://schema.tauri.app/config/2",'
                '"productName":"ArforgeAcceptance","version":"0.1.0",'
                '"identifier":"dev.arforge.acceptance",'
                '"build":{"frontendDist":"dist"},'
                '"app":{"windows":[{"title":"Arforge Acceptance"}]}}\n'
            ),
            "dist/index.html": "<!doctype html><title>Arforge Acceptance</title>\n",
        },
        commands=(("cargo", "check"),),
    ),
    "framework-flutter": StackFixture(
        files={
            "pubspec.yaml": (
                "name: arforge_acceptance\nenvironment:\n  sdk: '>=3.8.0 <4.0.0'\n"
                "dev_dependencies:\n  test: ^1.25.0\n"
            ),
            "lib/calculator.dart": "int add(int left, int right) => left + right;\n",
            "test/calculator_test.dart": (
                "import 'package:test/test.dart';\n"
                "import 'package:arforge_acceptance/calculator.dart';\n"
                "void main() { test('adds', () => expect(add(20, 22), 42)); }\n"
            ),
        },
        commands=(
            _docker(
                "ghcr.io/cirruslabs/flutter:3.32.8",
                "flutter",
                "test",
            ),
        ),
    ),
    "framework-spring": StackFixture(
        files={
            "pom.xml": (
                '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
                "  <modelVersion>4.0.0</modelVersion><groupId>dev.arforge</groupId>"
                "<artifactId>spring-fixture</artifactId><version>1</version>\n"
                "  <properties><maven.compiler.release>17</maven.compiler.release>"
                "<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>\n"
                "  <dependencies><dependency><groupId>org.springframework</groupId>"
                "<artifactId>spring-context</artifactId><version>6.2.10</version></dependency>"
                "<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId>"
                "<version>5.11.4</version><scope>test</scope></dependency></dependencies>\n"
                "  <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId>"
                "<artifactId>maven-surefire-plugin</artifactId><version>3.5.2</version>"
                "</plugin></plugins></build></project>\n"
            ),
            "src/test/java/dev/arforge/SpringContextTest.java": (
                "package dev.arforge;\n"
                "import static org.junit.jupiter.api.Assertions.assertEquals;\n"
                "import org.junit.jupiter.api.Test;\n"
                "import org.springframework.context.annotation.*;\n"
                "final class SpringContextTest {\n"
                " @Configuration static class Config { @Bean String answer(){ return \"42\"; } }\n"
                " @Test void contextLoads(){ try(var context = new "
                "AnnotationConfigApplicationContext(Config.class)){"
                "assertEquals(\"42\", context.getBean(String.class));} }\n"
                "}\n"
            ),
        },
        commands=(("mvn", "-q", "test"),),
    ),
    "db-sqlite": StackFixture(
        files={
            "acceptance.py": (
                "import sqlite3\n"
                "db = sqlite3.connect(':memory:')\n"
                "db.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)')\n"
                "db.execute('INSERT INTO items(value) VALUES (?)', ('arforge',))\n"
                "db.commit()\n"
                "assert db.execute('SELECT value FROM items').fetchone() == ('arforge',)\n"
                "print('PASS')\n"
            )
        },
        commands=(("{python}", "acceptance.py"),),
    ),
    "db-mysql": StackFixture(
        files={"README.txt": "MySQL isolated create/write/read fixture.\n"},
        commands=(
            (
                "docker",
                "run",
                "--rm",
                "-e",
                "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
                "-e",
                "MYSQL_INITDB_SKIP_TZINFO=1",
                "--entrypoint",
                "bash",
                "mysql:8.4",
                "-lc",
                (
                    "docker-entrypoint.sh mysqld --skip-networking >/tmp/mysql.log 2>&1 & pid=$!; "
                    "for i in {1..60}; do grep -q 'MySQL init process done' /tmp/mysql.log "
                    "&& break; sleep 1; done; "
                    "for i in {1..60}; do mysqladmin ping --silent && break; sleep 1; done; "
                    "mysql -uroot -e \"CREATE DATABASE acceptance; "
                    "CREATE TABLE acceptance.items(value VARCHAR(32)); "
                    "INSERT INTO acceptance.items VALUES ('arforge');\"; "
                    "test \"$(mysql -N -uroot -e 'SELECT value FROM acceptance.items')\" = arforge; "
                    "mysqladmin -uroot shutdown; wait $pid"
                ),
            ),
        ),
    ),
    "db-postgresql": StackFixture(
        files={"README.txt": "PostgreSQL isolated create/write/read fixture.\n"},
        commands=(
            (
                "docker",
                "run",
                "--rm",
                "-e",
                "POSTGRES_PASSWORD=acceptance",
                "--entrypoint",
                "bash",
                "postgres:17-alpine",
                "-lc",
                (
                    "docker-entrypoint.sh postgres & pid=$!; "
                    "for i in $(seq 1 60); do pg_isready -U postgres && break; sleep 1; done; "
                    "psql -v ON_ERROR_STOP=1 -U postgres -c "
                    "\"CREATE TABLE items(value text); INSERT INTO items VALUES ('arforge');\"; "
                    "test \"$(psql -At -U postgres -c 'SELECT value FROM items')\" = arforge; "
                    "kill -TERM $pid; "
                    "for i in $(seq 1 15); do kill -0 $pid 2>/dev/null || exit 0; sleep 1; done; "
                    "kill -KILL $pid"
                ),
            ),
        ),
    ),
    "db-redis": StackFixture(
        files={"README.txt": "Redis isolated write/read fixture.\n"},
        commands=(
            (
                "docker",
                "run",
                "--rm",
                "--entrypoint",
                "sh",
                "redis:8-alpine",
                "-lc",
                (
                    "redis-server --daemonize yes; "
                    "redis-cli SET arforge acceptance >/dev/null; "
                    "test \"$(redis-cli GET arforge)\" = acceptance; "
                    "redis-cli shutdown"
                ),
            ),
        ),
    ),
    "db-mongodb": StackFixture(
        files={"README.txt": "MongoDB isolated insert/read fixture.\n"},
        commands=(
            (
                "docker",
                "run",
                "--rm",
                "--entrypoint",
                "bash",
                "mongo:8.0",
                "-lc",
                (
                    "mkdir -p /tmp/mongo; "
                    "mongod --dbpath /tmp/mongo --bind_ip 127.0.0.1 "
                    "--fork --logpath /tmp/mongod.log; "
                    "mongosh --quiet --eval "
                    "\"db=db.getSiblingDB('acceptance'); db.items.insertOne({value:'arforge'}); "
                    "if(db.items.findOne({value:'arforge'}).value!='arforge') quit(1);\"; "
                    "mongod --dbpath /tmp/mongo --shutdown"
                ),
            ),
        ),
    ),
    "db-oracle": StackFixture(
        files={
            "acceptance.sql": (
                "WHENEVER SQLERROR EXIT SQL.SQLCODE\n"
                "CREATE TABLE acceptance_items(value VARCHAR2(32) NOT NULL);\n"
                "INSERT INTO acceptance_items(value) VALUES ('arforge');\n"
                "COMMIT;\n"
                "DECLARE\n  observed VARCHAR2(32);\n"
                "BEGIN\n"
                "  SELECT value INTO observed FROM acceptance_items;\n"
                "  IF observed <> 'arforge' THEN RAISE_APPLICATION_ERROR(-20001, 'mismatch'); END IF;\n"
                "END;\n/\n"
                "EXIT 0\n"
            )
        },
        commands=(
            (
                "docker",
                "run",
                "--rm",
                "-v",
                "{workspace}:/work",
                "-e",
                "ORACLE_PASSWORD=ArforgeAcceptance1",
                "-e",
                "APP_USER=arforge",
                "-e",
                "APP_USER_PASSWORD=ArforgeAcceptance1",
                "--entrypoint",
                "bash",
                "gvenzl/oracle-free:23-slim-faststart",
                "-lc",
                (
                    "/opt/oracle/container-entrypoint.sh >/tmp/oracle.log 2>&1 & pid=$!; "
                    "for i in $(seq 1 180); do /opt/oracle/healthcheck.sh >/dev/null 2>&1 "
                    "&& break; sleep 1; done; "
                    "/opt/oracle/healthcheck.sh >/dev/null 2>&1 || "
                    "{ tail -200 /tmp/oracle.log; exit 1; }; "
                    "sqlplus -s arforge/ArforgeAcceptance1@localhost/FREEPDB1 "
                    "@/work/acceptance.sql; rc=$?; kill -TERM $pid; exit $rc"
                ),
            ),
        ),
    ),
    "db-vector": StackFixture(
        files={
            "acceptance.py": (
                "import chromadb\n"
                "client = chromadb.EphemeralClient()\n"
                "collection = client.create_collection('acceptance')\n"
                "collection.add(ids=['a','b'], documents=['alpha','beta'], "
                "embeddings=[[1.0,0.0],[0.0,1.0]])\n"
                "result = collection.query(query_embeddings=[[0.9,0.1]], n_results=1)\n"
                "assert result['ids'] == [['a']]\n"
                "print('PASS')\n"
            )
        },
        commands=(("{python}", "acceptance.py"),),
    ),
    "tool-maven": StackFixture(
        files=_MAVEN_JUNIT_FILES,
        commands=(("mvn", "-q", "package"),),
    ),
    "tool-gradle": StackFixture(
        files={
            "settings.gradle": "rootProject.name = 'arforge-acceptance'\n",
            "build.gradle": (
                "tasks.register('verify') { doLast { "
                "assert (20 + 22) == 42; println 'PASS' } }\n"
            ),
        },
        commands=(
            _gradle_docker(
                "gradle",
                "verify",
                "--no-daemon",
                "--console=plain",
            ),
        ),
    ),
    "tool-npm": StackFixture(
        files=_NODE_FILES,
        commands=(("npm", "test", "--silent"),),
    ),
    "tool-pnpm": StackFixture(
        files=_NODE_FILES,
        commands=(("pnpm", "test", "--silent"),),
    ),
    "tool-pip": StackFixture(
        files={
            "pyproject.toml": (
                "[build-system]\n"
                'requires = ["setuptools>=68"]\n'
                'build-backend = "setuptools.build_meta"\n'
                "[project]\n"
                'name = "arforge-acceptance-fixture"\n'
                'version = "0.0.1"\n'
            ),
            "acceptance_fixture.py": "VALUE = 42\n",
        },
        commands=(
            (
                "{python}",
                "-m",
                "pip",
                "wheel",
                ".",
                "--no-deps",
                "--wheel-dir",
                "dist",
                "--disable-pip-version-check",
            ),
        ),
    ),
    "tool-poetry": StackFixture(
        files={
            "pyproject.toml": (
                "[tool.poetry]\nname='arforge-acceptance'\nversion='0.1.0'\n"
                "description='acceptance'\nauthors=['Arforge']\npackages=[{include='calc'}]\n"
                "[tool.poetry.dependencies]\npython='>=3.11'\n"
                "[tool.poetry.group.dev.dependencies]\npytest='^8.0'\n"
                "[build-system]\nrequires=['poetry-core']\n"
                "build-backend='poetry.core.masonry.api'\n"
            ),
            "calc/__init__.py": "def add(left, right): return left + right\n",
            "tests/test_calc.py": (
                "from calc import add\n"
                "def test_add(): assert add(20, 22) == 42\n"
            ),
        },
        commands=(
            ("{python}", "-m", "venv", ".venv"),
            ("{venv_python}", "-m", "pip", "install", "poetry==2.1.4", "--quiet"),
            ("{venv_python}", "-m", "poetry", "install", "--no-interaction", "--quiet"),
            ("{venv_python}", "-m", "poetry", "run", "pytest", "-q"),
        ),
    ),
    "tool-cargo": StackFixture(
        files={
            "Cargo.toml": (
                "[package]\n"
                'name = "arforge_acceptance"\n'
                'version = "0.1.0"\n'
                'edition = "2021"\n'
            ),
            "src/lib.rs": (
                "pub fn add(left: i32, right: i32) -> i32 { left + right }\n"
                "#[cfg(test)] mod tests { use super::*; "
                "#[test] fn adds() { assert_eq!(add(20, 22), 42); } }\n"
            ),
        },
        commands=(("cargo", "test", "--quiet"),),
    ),
    "tool-go-mod": StackFixture(
        files=_GO_FILES,
        commands=(
            _docker("golang:1.24-alpine", "go", "mod", "verify"),
            _docker("golang:1.24-alpine", "go", "test", "./..."),
        ),
    ),
    "tool-cmake": StackFixture(
        files={
            "CMakeLists.txt": (
                "cmake_minimum_required(VERSION 3.20)\n"
                "project(arforge_acceptance C)\n"
                "enable_testing()\nadd_executable(acceptance main.c)\n"
                "add_test(NAME acceptance COMMAND acceptance)\n"
            ),
            "main.c": (
                "#include <assert.h>\n"
                "int main(void){ assert(20 + 22 == 42); return 0; }\n"
            ),
        },
        commands=(
            ("{python}", "-m", "venv", ".venv"),
            (
                "{venv_python}",
                "-m",
                "pip",
                "install",
                "cmake==4.0.3",
                "ninja==1.11.1.4",
                "--quiet",
            ),
            (
                "{venv_cmake}",
                "-S",
                ".",
                "-B",
                "build",
                "-G",
                "Ninja",
                "-DCMAKE_C_COMPILER=C:/Program Files/mingw64/bin/gcc.exe",
                "-DCMAKE_MAKE_PROGRAM={venv_ninja}",
            ),
            ("{venv_cmake}", "--build", "build"),
            ("build/acceptance.exe",),
        ),
    ),
    "test-pytest": StackFixture(
        files=_PYTHON_FILES,
        commands=(("{python}", "-m", "pytest", "-q"),),
    ),
    "test-junit": StackFixture(
        files=_MAVEN_JUNIT_FILES,
        commands=(("mvn", "-q", "test"),),
    ),
    "test-jest": StackFixture(
        files={
            "package.json": (
                '{"private":true,"scripts":{"test":"jest --runInBand"}}\n'
            ),
            "sum.js": (
                "const add = (left, right) => left + right;\n"
                "module.exports = {add};\n"
            ),
            "sum.test.js": (
                "const {add} = require('./sum.js');\n"
                "test('adds', () => expect(add(20, 22)).toBe(42));\n"
            ),
        },
        commands=(
            ("npm", "install", "jest@30.0.5", "--no-audit", "--no-fund", "--silent"),
            ("npm", "test", "--silent"),
        ),
    ),
    "test-playwright": StackFixture(
        files={
            "package.json": (
                '{"private":true,"type":"module","scripts":{"test":"playwright test"}}\n'
            ),
            "acceptance.spec.js": (
                "import {test, expect} from '@playwright/test';\n"
                "test('runner assertion', async () => { expect(20 + 22).toBe(42); });\n"
            ),
        },
        commands=(
            (
                "npm",
                "install",
                "@playwright/test@1.54.2",
                "--no-audit",
                "--no-fund",
                "--silent",
            ),
            ("npm", "test", "--silent"),
        ),
    ),
    "test-cypress": StackFixture(
        files={
            "cypress.config.js": (
                "const {defineConfig}=require('cypress');\n"
                "module.exports=defineConfig({e2e:{supportFile:false}});\n"
            ),
            "cypress/e2e/acceptance.cy.js": (
                "describe('acceptance',()=>{it('executes',()=>{expect(20+22).to.eq(42);});});\n"
            ),
        },
        commands=(
            _docker(
                "cypress/included:14.5.4",
                "cypress",
                "run",
                "--browser",
                "electron",
            ),
        ),
    ),
    "test-selenium": StackFixture(
        files={
            "acceptance.py": (
                "from selenium import webdriver\n"
                "from selenium.webdriver.common.by import By\n"
                "options = webdriver.ChromeOptions()\n"
                "options.add_argument('--headless=new')\n"
                "options.add_argument('--disable-gpu')\n"
                "options.add_argument('--no-sandbox')\n"
                "driver = webdriver.Chrome(options=options)\n"
                "try:\n"
                "    driver.get('data:text/html,<main id=\"app\">Arforge</main>')\n"
                "    assert driver.find_element(By.ID, 'app').text == 'Arforge'\n"
                "    print('PASS')\n"
                "finally:\n"
                "    driver.quit()\n"
            )
        },
        commands=(("{python}", "acceptance.py"),),
    ),
    "devops-kubernetes": StackFixture(
        files={"README.txt": "Kubernetes client-side object generation fixture.\n"},
        commands=(
            (
                "kubectl",
                "create",
                "deployment",
                "arforge-acceptance",
                "--image=nginx:1.27-alpine",
                "--dry-run=client",
                "-o",
                "yaml",
            ),
        ),
    ),
    "devops-docker": StackFixture(
        files={"README.txt": "Docker Engine container execution fixture.\n"},
        commands=(("docker", "run", "--rm", "alpine:3.22", "sh", "-c", "test $((20+22)) -eq 42"),),
    ),
    "devops-cicd": StackFixture(
        files=_GITHUB_WORKFLOW_FILES,
        commands=(("{python}", "pipeline.py"), ("git", "init", "--quiet")),
    ),
    "devops-github-actions": StackFixture(
        files=_GITHUB_WORKFLOW_FILES,
        commands=(("{python}", "pipeline.py"),),
    ),
    "devops-nginx": StackFixture(
        files={
            "nginx.conf": (
                "events {}\nhttp { server { listen 8080; "
                "location / { return 200 'Arforge'; } } }\n"
            )
        },
        commands=(
            _docker(
                "nginx:1.27-alpine",
                "nginx",
                "-t",
                "-c",
                "/work/nginx.conf",
            ),
        ),
    ),
}


def get_stack_fixture(capability_id: str) -> StackFixture | None:
    return FIXTURES.get(capability_id)
