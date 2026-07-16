// Headless rendering for the jsonld provider and discovery.
//
// WHY THE IMPORT IS HIDDEN FROM THE BUNDLER
// -----------------------------------------
// Playwright is a devDependency: it exists on the dev machine (verify-ui already
// uses it) and does NOT exist inside a Vercel serverless function — no package,
// no chromium binary. A literal `import("@playwright/test")` gets statically
// resolved by Next's bundler at build time, which would either drag ~8MB of test
// runner into every serverless bundle or fail the build outright. Routing the
// import through `new Function` makes it invisible to static analysis: locally it
// resolves and we can render; on Vercel it rejects and every caller degrades to
// static-fetch-only. That degradation is SAFE because the cron additionally skips
// renderMode="playwright" boards (see registry.listPollableBoards) — nothing in
// the serverless path ever NEEDS a browser, it just tolerates one being absent.

type ChromiumLike = {
  launch(opts?: { headless?: boolean }): Promise<{
    newPage(opts?: { userAgent?: string }): Promise<PageLike>;
    close(): Promise<void>;
  }>;
};

export type PageLike = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const hiddenImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;

let chromiumPromise: Promise<ChromiumLike | null> | null = null;

/** The Playwright chromium launcher, or null where Playwright isn't installed. */
export function getChromium(): Promise<ChromiumLike | null> {
  chromiumPromise ??= hiddenImport("@playwright/test")
    .then((m) => (m as { chromium: ChromiumLike }).chromium)
    .catch(() => null);
  return chromiumPromise;
}

export async function renderingAvailable(): Promise<boolean> {
  return (await getChromium()) !== null;
}

const RENDER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

export interface RenderedPage {
  html: string;
  finalUrl: string;
}

/**
 * Run `fn` with a shared browser. One launch per batch, not per page — a board
 * pull renders dozens of pages and chromium startup is ~1s each.
 */
export async function withBrowser<T>(
  fn: (render: (url: string, waitForMarker?: string) => Promise<RenderedPage | null>) => Promise<T>
): Promise<T | null> {
  const chromium = await getChromium();
  if (!chromium) return null;
  const browser = await chromium.launch();
  try {
    const render = async (url: string, waitForMarker?: string): Promise<RenderedPage | null> => {
      let page: PageLike | null = null;
      try {
        page = await browser.newPage({ userAgent: RENDER_UA });
        // "networkidle" hangs forever on pages with analytics beacons; "load" +
        // a bounded wait for the content we actually need is both faster and
        // more reliable.
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        if (waitForMarker) {
          await page
            .waitForFunction(
              `document.documentElement.innerHTML.includes(${JSON.stringify(waitForMarker)})`,
              undefined,
              { timeout: 8_000 }
            )
            .catch(() => {}); // marker never appearing is an answer, not an error
        }
        return { html: await page.content(), finalUrl: page.url() };
      } catch {
        return null;
      } finally {
        await page?.close().catch(() => {});
      }
    };
    return await fn(render);
  } finally {
    await browser.close().catch(() => {});
  }
}
