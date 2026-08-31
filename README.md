# @biteno/openclaw-memory-tencentdb

> **Remote TencentDB Agent Memory Plugin for OpenClaw** — Bidirectional prefetch recall & asynchronous turn sync for central TencentDB Agent Memory clusters.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E=2026.1.0-orange)](https://github.com/openclaw/openclaw)
[![Node](https://img.shields.io/badge/node-%3E=20.0-brightgreen)](https://nodejs.org/)

---

## 🎯 Übersicht

Dieses Plugin verbindet **OpenClaw** nativ mit einem zentralen **TencentDB Agent Memory Cluster** (`http://<your-tencentdb-host>:8420`). 

Im Gegensatz zum offiziellen lokalen NPM-Paket (das eine isolierte SQLite-Datenbank auf der lokalen Maschine betreibt) und im Gegensatz zum transparenten Proxy (der individuelle API-Keys und Token-Budgets im LLM-Proxy verliert), arbeitet dieses Plugin als **schlanker, nativer HTTP-Client**:

- 🔍 **Automatischer Prefetch (`before_agent_start`):** Durchsucht vor jedem Turn das zentrale Gedächtnis (`/v2/conversation/search` & `/v3/skill/search` auf Port `8420`) und injiziert relevante Erinnerungen in `<tencentdb-memory>`.
- ⚡ **Asynchroner Turn-Sync (`agent_end`):** Überträgt abgeschlossene Nutzer- und Assistenten-Nachrichten nicht-blockierend an die zentrale Turn-Import-API (`/api/v1/chat-memory/import` auf Port `8125`).
- 🛠️ **Integrierte On-Demand Werkzeuge:** Stellt OpenClaw die Tools `tdai_conversation_search`, `tdai_skill_search`, `tdai_wiki_search` und `tdai_codegraph_search` bereit.
- 🏢 **Zentrales Flottengedächtnis:** OpenClaw teilt das Wissen in Echtzeit mit anderen Agenten (Hermes, Claude Code, etc.) im selben Team-Namespace.

---

## 🏗️ Architektur & Microservices

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            OpenClaw Instanz                                 │
│                                                                             │
│  [before_agent_start] ──(1. Prefetch)──┐   ▲──(3. Context Injection)──┐     │
│  [agent_end]          ──(4. Sync Turn)─┼─┐ │                          │     │
│  [Tools]              ──(5. Search)────┼─┼─┼────────────────────────┐ │     │
└────────────────────────────────────────┼─┼─┼────────────────────────┼─┼─────┘
                                         │ │ │                        │ │
             ┌───────────────────────────┘ │ └──────────────┐         │ │
             ▼                             ▼                │         ▼ ▼
┌─────────────────────────┐   ┌──────────────────────────┐  │  ┌─────────────────────────┐
│       MemoryCore        │   │       MemoryPanel        │  │  │     MemoryKnowledge     │
│       Port :8420        │   │        Port :8125        │  │  │       Port :8424        │
│  • L0–L3 Hybrid Search  │   │  • /api/v1/chat-memory/  │  │  │  • Team Wiki Search     │
│  • Skill & Fact Recall  │   │    import (L0 Ingest)    │  │  │  • CodeGraph Impact     │
└─────────────────────────┘   └──────────────────────────┘  │  └─────────────────────────┘
                                                            │
                                         ┌──────────────────┘
                                         ▼
                             ┌───────────────────────┐
                             │  LLM Gateway / Proxy  │
                             │  (OpenAI / LiteLLM)   │
                             └───────────────────────┘
```

---

## 📦 1. Installation

```bash
# In das OpenClaw Extensions-Verzeichnis wechseln
mkdir -p ~/.openclaw/extensions/
cd ~/.openclaw/extensions/
git clone https://github.com/biteno/openclaw-memory-tencentdb.git

# In das Verzeichnis wechseln
cd openclaw-memory-tencentdb
```

*Hinweis: Das Repository enthält alle vorkompilierten Laufzeit-Dateien im Ordner `dist/`.*

---

## ⚙️ 2. Konfiguration (`~/.openclaw/openclaw.json`)

Füge den Plugin-Eintrag in deine `~/.openclaw/openclaw.json` ein. 

> 💡 **Wichtig:** 
> 1. Setze `"slots": { "memory": "openclaw-memory-tencentdb" }`, damit OpenClaw das Plugin als primären Speicheranbieter aktiviert.
> 2. Setze `"hooks": { "allowConversationAccess": true }`, damit OpenClaw dem Plugin den Zugriff auf abgeschlossene Dialog-Turns (für den Turn-Sync) gestattet.

```jsonc
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": [
        "/root/.openclaw/extensions/openclaw-memory-tencentdb"
      ]
    },
    "slots": {
      "memory": "openclaw-memory-tencentdb"
    },
    "entries": {
      "openclaw-memory-tencentdb": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "coreUrl": "http://<your-tencentdb-host>:8420",
          "importUrl": "http://<your-tencentdb-host>:8125",
          "knowledgeUrl": "http://<your-tencentdb-host>:8424",
          "userKey": "sk-mem-YOUR_TENCENTDB_KEY",
          "teamId": "team-your-team-id",
          "agentId": "agt-your-agent-id",
          "autoRecall": true,
          "autoCapture": true,
          "scoreThreshold": 0.5,
          "maxRecallResults": 3
        }
      }
    }
  }
}
```

### Parameter-Referenz:

| Parameter | Typ | Standardwert | Beschreibung |
| :--- | :--- | :--- | :--- |
| `coreUrl` | String | `http://localhost:8420` | URL des TencentDB MemoryCore (:8420) für semantische L0–L3 Suche. |
| `importUrl` | String | `http://localhost:8125` | URL des MemoryPanel (:8125) für den asynchronen Turn-Import. |
| `knowledgeUrl` | String | `http://localhost:8424` | URL des MemoryKnowledge (:8424) für Wiki- und CodeGraph-Suche. |
| `userKey` | String | `sk-mem-...` | Persönlicher TencentDB Access Key aus `.admin-key` oder Profil. |
| `teamId` | String | `default` | Team-Identifier / Mandant in TencentDB. |
| `agentId` | String | `default` | Eindeutige Kennung dieser OpenClaw-Instanz. |
| `autoRecall` | Boolean | `true` | Automatischer Wissensabruf vor jeder Nutzeranfrage. |
| `autoCapture` | Boolean | `true` | Automatischer asynchroner Turn-Import nach jeder Antwort. |
| `scoreThreshold` | Number | `0.5` | Mindest-Ähnlichkeitsscore (0.0 – 1.0) für injizierte Erinnerungen. |
| `maxRecallResults` | Number | `3` | Maximale Anzahl an Konversationserinnerungen im Prompt. |

---

## 🛠️ 3. Bereitgestellte Werkzeuge (Tools)

Dem Agenten stehen automatisch folgende Werkzeuge für gezielte Abfragen zur Verfügung:

1. **`tdai_conversation_search`**:
   * Durchsucht frühere Konversationen und gelöste Problemstellungen semantisch.
   * Parameter: `query` (String), `limit` (optional, Default: 5).
2. **`tdai_skill_search`**:
   * Durchsucht hinterlegte SOPs, Workflows und Best Practices.
   * Parameter: `query` (String), `limit` (optional, Default: 5).
3. **`tdai_wiki_search`**:
   * Durchsucht das zentrale Team-Wiki auf Port 8424.
   * Parameter: `query` (String), `wiki_id` (optional), `limit` (optional, Default: 5).
4. **`tdai_codegraph_search`**:
   * Durchsucht den Code-Graph nach Symbolen, Funktionen und Abhängigkeiten.
   * Parameter: `query` (String), `limit` (optional, Default: 5).

---

## 🔄 4. Validierung & Neustart

```bash
# 1. Konfiguration prüfen
openclaw config validate

# 2. Schnittstellentest durchführen (optional)
node dist/debug.js

# 3. Gateway neu starten
openclaw gateway restart

# 4. Live-Logs überwachen
openclaw logs --follow
```

---

## 📥 5. Einmaliger Initial-Import (Bestehende lokale Erinnerungen migrieren)

Wenn der Agent bereits vor der TencentDB-Anbindung genutzt wurde und lokale Gedächtnisdateien (`MEMORY.md` sowie tägliche Notizen unter `~/.openclaw/workspace/memory/*.md`) besitzt, können diese mit dem integrierten Migrations-Tool mit einem einzigen Befehl nach TencentDB importiert werden:

```bash
cd /root/.openclaw/extensions/openclaw-memory-tencentdb
node dist/import-memory.js
```

**Was dieser Befehl ausführt:**
* Liest strukturiert alle Abschnitte der Datei `MEMORY.md` aus.
* Scannt alle historischen Markdown-Dateien im Verzeichnis `workspace/memory/`.
* Teilt überlange Dateien (>7.000 Zeichen) automatisch in logische Chunks auf, um das API-Limit von TencentDB einzuhalten.
* Schreibt alle Fakten lückenlos in **TencentDB L0** unter der in `openclaw.json` konfigurierten `agentId` und `teamId`.

---

## 📄 Lizenz

MIT License — Copyright (c) 2026 Biteno GmbH
