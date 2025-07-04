import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import { google, sheets_v4 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

/**
 * Convenience row/column typings.
 */
export type Cell = string | number | boolean | null;
export type Row = Cell[];
export type Rows = Row[];

/**
 * Thin wrapper around Google Sheets v4 API that supports either
 * service-account credentials (preferred for non-interactive/server use)
 * or an OAuth2 ?installed application? flow (fallback for local/dev).
 */
export class GoogleSheetsService {
  private authClient?: OAuth2Client;
  private sheets?: sheets_v4.Sheets;
  private authPromise?: Promise<void>;

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Retrieve full Spreadsheet resource.
   */
  async getSpreadsheet(spreadsheetId: string) {
    await this.ensureAuth();
    return this.retry(() =>
      this.sheets!.spreadsheets.get({ spreadsheetId })
    );
  }

  /**
   * Fetch a range of rows (values) from the spreadsheet.
   */
  async fetchRows(
    spreadsheetId: string,
    range: string
  ): Promise<sheets_v4.Schema$ValueRange> {
    await this.ensureAuth();
    const res = await this.retry(() =>
      this.sheets!.spreadsheets.values.get({ spreadsheetId, range })
    );
    return res.data;
  }

  /**
   * Update a range of rows with provided values.
   * `values` must be a 2-D array matching the dimensions of the range.
   */
  async updateRows(
    spreadsheetId: string,
    range: string,
    values: Rows
  ): Promise<void> {
    await this.ensureAuth();
    await this.retry(() =>
      this.sheets!.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { range, majorDimension: 'ROWS', values },
      })
    );
  }

  /**
   * Append a single row at the end of the sheet.
   */
  async appendRow(spreadsheetId: string, values: Row): Promise<void> {
    await this.ensureAuth();
    await this.retry(() =>
      this.sheets!.spreadsheets.values.append({
        spreadsheetId,
        range: 'A1', // API ignores range for append; A1 keeps it valid.
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { majorDimension: 'ROWS', values: [values] },
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Authentication                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Authenticate lazily;
   * only one auth flow may run concurrently.
   */
  private async authenticate(interactive: boolean) {
    if (this.authPromise) {
      await this.authPromise;
      return;
    }

    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

    /* Ensure only one auth flow runs concurrently */
    this.authPromise = (async () => {
      // Prefer Application Default / Service-Account credentials.
      if (!interactive && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const auth = new google.auth.GoogleAuth({ scopes });
        this.authClient = (await auth.getClient()) as OAuth2Client;
      } else {
        // OAuth2 local flow
        const baseDir =
          process.env.GOOGLE_SHEETS_CREDENTIALS_DIR ||
          path.join(process.env.HOME ?? process.cwd(), '.config', 'omniform');
        const credentialsPath = path.resolve(baseDir, 'credentials.json');
        const tokenPath = path.resolve(baseDir, 'token.json');

        if (!fsSync.existsSync(credentialsPath)) {
          throw new Error(
            `Missing OAuth client credentials file at ${credentialsPath}`
          );
        }

        const creds = JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
        const { client_secret, client_id, redirect_uris } =
          creds.installed || creds.web;

        const oAuth2Client = new google.auth.OAuth2(
          client_id,
          client_secret,
          redirect_uris[0]
        );

        if (fsSync.existsSync(tokenPath)) {
          const token = JSON.parse(await fs.readFile(tokenPath, 'utf-8'));
          oAuth2Client.setCredentials(token);
        } else {
          if (!interactive) {
            throw new Error(
              'OAuth token not found and interactive mode is disabled.'
            );
          }
          const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
          });
          console.log('Authorize this app by visiting this url:\n', authUrl);
          const code = await this.prompt('Enter the authorization code: ');
          const { tokens } = await oAuth2Client.getToken(code.trim());
          oAuth2Client.setCredentials(tokens);
          await fs.mkdir(baseDir, { recursive: true });
          await fs.writeFile(tokenPath, JSON.stringify(tokens), 'utf-8');
        }
        this.authClient = oAuth2Client;
      }

      this.sheets = google.sheets({ version: 'v4', auth: this.authClient });
    })();

    await this.authPromise;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Retry helper with exponential back-off.
   */
  async retry<T, E extends Error = Error>(
    fn: () => Promise<T>,
    attempts = 3
  ): Promise<T> {
    let lastErr: E | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = (err instanceof Error ? err : new Error(String(err))) as E;
        const wait = 2 ** i * 250 + Math.random() * 100;
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    /* If we get here, all attempts failed */
    throw lastErr!;
  }

  private async ensureAuth() {
    if (!this.authClient || !this.sheets) {
      await this.authenticate(false);
    }
  }

  private prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Default export ? singleton instance (optional convenience)         */
/* ------------------------------------------------------------------ */

export const googleSheetsService = new GoogleSheetsService();