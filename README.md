```markdown
# VibeSheet *OmniForm Phantom*
Universal JayZee Form-Filler  
_Project ID: **vibesheet-20250704_022354**_

> A privacy-first browser-extension **&** headless CLI that maps Google-Sheet rows to any form on the internet, fills them in bulk while mimicking natural user behaviour, handles CAPTCHAs and writes diagnostics back to the sheet ? all with zero-knowledge encryption.

---

## Table of Contents
1. [Why OmniForm Phantom?](#why-omniform-phantom)
2. [Features](#features)
3. [Architecture at a Glance](#architecture-at-a-glance)
4. [Getting Started](#getting-started)
   * [Prerequisites](#prerequisites)
   * [Installation](#installation)
   * [Build & Load the Extension](#build--load-the-extension)
   * [Using the CLI Agent](#using-the-cli-agent)
5. [Configuration](#configuration)
   * [Google Sheets OAuth](#google-sheets-oauth)
   * [Selector Mapping](#selector-mapping)
6. [Usage Walk-through](#usage-walk-through)
7. [Project Layout & Components](#project-layout--components)
8. [Tech Stack / Dependencies](#tech-stack--dependencies)
9. [Scripts & NPM Tasks](#scripts--npm-tasks)
10. [Testing & CI](#testing--ci)
11. [Security Notes](#security-notes)
12. [Roadmap](#roadmap)
13. [Contributing](#contributing)
14. [License](#license)

---

## Why OmniForm Phantom?
Bulk form filling normally means brittle X-Path macros, plaintext credentials and CAPTCHAs that break at 2 a.m. **OmniForm Phantom** fixes that by

* Scanning the live DOM (including shadow DOM & iframes) and ranking selectors automatically  
* Letting you map those selectors to columns in a Google Sheet ? visually  
* Simulating human typing, mouse movement & randomised waits so your traffic looks organic  
* Solving CAPTCHAs through pluggable services or manual fall-back  
* Writing statuses, screenshots and error codes **back** to the sheet for auditability  
* Encrypting everything locally with AES-GCM; no cloud ever sees your selectors or secrets  

---

## Features
* ? **DOM + ShadowDOM crawler** with heuristic precision ranking  
* ? **Google Sheets PKCE OAuth** (no server component) ? robust retry & back-off  
* ? **AES-256-GCM vault** for selectors & credentials (Chrome storage or IndexedDB)  
* ?? **HumanSimulator** ? keystroke cadence, mouse jitter, randomised delays  
* ? **CaptchaHandler** ? 2Captcha / Anti-Captcha / custom provider adaptor  
* ?? **Parallel runs** (multi-tab or Playwright pool in headless mode)  
* ? **WCAG-AA compliant** React wizard (keyboard-only accessible)  
* ?? **CLI Agent** ? ideal for CI pipelines; YAML/JSON config driven  
* ? **Encrypted audit log** + screenshot archive  
* ? **i18n ready** (extractable `messages.pot`)  

---

## Architecture at a Glance
```
monorepo/
??? extension/              # Manifest V3 Chrome/Edge extension (Vite + TS + React)
?   ??? src/
?   ?   ??? background.ts   # Event orchestrator
?   ?   ??? contentScript.ts# DOM scanner & form filler
?   ?   ??? popup/          # React wizard
??? cli/                    # Node 18 + Playwright headless agent
?   ??? runJob.ts
?   ??? browserPool.ts
?   ??? configLoader.ts
??? shared/                 # Isomorphic utils (crypto, types)
??? tests/                  # Jest unit & Playwright e2e
??? .github/workflows/ci.yml
```

> A single **npm-workspace** drives both the extension and CLI, sharing type-safe utilities under `shared/`.

---

## Getting Started

### Prerequisites
| Tool | Version |
|------|---------|
| Node | ? 18.x  |
| npm  | ? 9.x   |
| Chrome / Edge / Chromium | any MV3-capable build |
| (Optional) Playwright Browsers | auto-installed by `npx playwright install` |

### Installation
```bash
git clone https://github.com/your-org/vibesheet-20250704_022354.git
cd vibesheet-20250704_022354
npm install          # installs root & all workspace deps
```

### Build & Load the Extension
```bash
# Production build
npm run build:ext     # vite ? dist/extension/

# In Chrome:
# 1. chrome://extensions
# 2. Enable "Developer mode"
# 3. "Load unpacked" ? select dist/extension
```

During development you may also run:

```bash
npm run dev:ext       # Vite HMR for popup & content script (with autoreload)
```

### Using the CLI Agent
```bash
# Configuration lives in config/job.yml
cp config/default.ini myJob.yml  # or craft JSON

# Run a headless batch (Playwright)
npm run cli -- --config myJob.yml

# or shorter
node cli/runJob.js --sheet "1B..." --mapping mapping.csv
```

---

## Configuration

### Google Sheets OAuth
1. On first run the popup/CLI will open a Google consent screen.  
2. Grant _Drive_ & _Spreadsheets_ scopes.  
3. A refresh token is stored **encrypted** with your master password.  
4. Revoke at any time from https://myaccount.google.com/permissions  

### Selector Mapping
* Click **Scan** in the popup ? selectors are harvested.  
* A draft mapping table appears; columns auto-match (name similarity).  
* Confirm / adjust, then **Save** ? mapping is stored encrypted and synced (if `storage.sync` is enabled).  
* The CLI reads the same mapping from `sampleMapping.csv` or YAML.

---

## Usage Walk-through
### Extension
1. Open the target webpage with form(s).  
2. Click the Phantom icon ? **Scan** ? wait for results.  
3. Map columns `first_name`, `email`, ? to discovered selectors.  
4. Choose sheet rows (range or filter) and press **Run**.  
5. Watch as the extension fills, solves CAPTCHAs and updates the sheet.  
6. View logs/screenshots under **Logs ? Export**.

### CLI
```bash
npm run cli -- \
  --sheet "https://docs.google.com/spreadsheets/d/1B..." \
  --mapping config/sampleMapping.csv \
  --rows "2-500" \
  --captchaKey $ANTICAPTCHA_KEY \
  --headless      # default
```

Outputs: `artifacts/<timestamp>/` containing logs, screenshots, JSON summary.

---

## Project Layout & Components
| Path / File | Purpose |
|-------------|---------|
| `extension/src/background.ts` | Central orchestrator, message router |
| `extension/src/contentScript.ts` | Scans DOM, injects FormFiller |
| `extension/src/popup/App.tsx` | React wizard UI |
| `extension/src/services/DomScanner.ts` | Selector discovery & ranking |
| `extension/src/services/SelectorVault.ts` | AES-GCM local crypto store |
| `extension/src/services/MappingEngine.ts` | Auto & manual column mapping |
| `extension/src/services/GoogleSheetsService.ts` | OAuth, read/write rows |
| `extension/src/services/FormFillerRunner.ts` | Step through rows, emit events |
| `extension/src/services/HumanSimulator.ts` | Types & clicks naturally |
| `extension/src/services/CaptchaHandler.ts` | Abstraction over providers |
| `extension/src/services/AuditLogger.ts` | Encrypted on-device logs |
| `cli/runJob.ts` | Entry point for headless jobs |
| `cli/browserPool.ts` | Manages parallel Playwright contexts |
| `cli/configLoader.ts` | YAML/JSON ? runtime config validator |
| `shared/*` | Cross-runtime helpers (crypto, types, constants) |
| `tests/` | Jest unit and Playwright e2e suites |
| `config/default.ini` | Baseline runtime options |
| `config/sampleMapping.csv` | Example selector?column file |

(A full auto-generated tree is in [`docs/TREE.md`](docs/TREE.md).)

---

## Tech Stack / Dependencies
* **Runtime:** Node 18, Manifest V3, Chromium
* **Languages:** TypeScript 5, React 18, CSS Modules
* **Tooling:** Vite 5, Jest 29, Playwright 1.43, ESLint, Prettier
* **Crypto:** Web Crypto API (AES-GCM, PBKDF2)
* **CAPTCHA Providers:** 2Captcha, Anti-Captcha (pluggable)
* **CI/CD:** GitHub Actions (`.github/workflows/ci.yml`)
* **i18n:** `@formatjs/cli`

---

## Scripts & NPM Tasks
```bash
# Builds
npm run build        # lint + type-check + test + build ext + build cli
npm run build:ext    # extension only
npm run build:cli    # CLI only

# Development
npm run dev:ext      # HMR extension
npm run dev:cli      # ts-node watch

# Tests
npm test             # unit & e2e
npm run test:unit
npm run test:e2e     # Playwright

# Lint & Format
npm run lint
npm run format
```

---

## Testing & CI
* **Unit** tests use Jest + ts-jest in `tests/unit/**`.
* **End-to-End** uses Playwright against a mock form site.
* **GitHub Actions** workflow:
  1. ? `npm run lint`
  2. ?? `npm run build`
  3. ? `npm test`
  4. ? Publish extension zip & CLI tarball as artefacts
  5. ? (optional) Upload to Chrome Web Store via API

---

## Security Notes
* Zero-knowledge: selector vault & OAuth tokens are AES-encrypted locally; key derived from your master password with PBKDF2-SHA-512 & 200 k rounds.
* No outbound telemetry; optional anonymous metrics are **opt-in**.
* Secrets in CI should be stored as encrypted GitHub Actions secrets.

---

## Roadmap
- [ ] Firefox (Web-Extensions) & Safari (WKWebView) support  
- [ ] Native FIDO2 / WebAuthn flows  
- [ ] Smart AI mapping suggestions (Gemini / GPT-4)  
- [ ] Visual flow builder (drag-drop branching)  
- [ ] Team sync & share vault with TRESOR-ish forward secrecy  

---

## Contributing
Pull-requests, issues and discussions are welcome!  
Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and follow the code-style enforced by **ESLint + Prettier**.  

Local commit hooks are provided via **husky** to run lints before push.

---

## License
Distributed under the MIT License ? see [`LICENSE`](LICENSE).

Enjoy **VibeSheet OmniForm Phantom** and happy automated form filling! ?
```