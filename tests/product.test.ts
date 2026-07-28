import { expect, test } from "bun:test";
import {
  createTakosumiAppConnectHref,
  createDirectDeployHref,
  createFirstRunActions,
  createHostCenterHref,
  parseMobileConnectInput,
  takosumiAppHandoffFromSearch,
} from "@takosjp/mobile-kit";
import { productAdapter } from "../src/product.ts";
test("Yurumeet uses the yurume client on the shared Yurucommu server", () => {
  expect(productAdapter.product).toBe("yurume");
  expect(productAdapter.discoveryProduct).toBe("yurucommu");
  expect(productAdapter.requiredHostCapabilities).toEqual([
    "client.yurume.messages.v1",
  ]);
  expect(productAdapter.oidcScopes).toEqual(["openid", "profile", "email"]);
  expect(productAdapter.directDeployUrl).toContain(
    "deploy.workers.cloudflare.com",
  );
});

test("native chrome uses the Yurumeet accent", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain(
    `<meta name="theme-color" content="${productAdapter.accentColor}" />`,
  );
});

test("Yurumeet exposes manual, Cloudflare, and Takosumi setup paths", () => {
  expect(createFirstRunActions(productAdapter).map((action) => action.id)).toEqual(
    ["url", "qr", "direct-deploy", "host"],
  );
  expect(new URL(createDirectDeployHref(productAdapter)).hostname).toBe(
    "deploy.workers.cloudflare.com",
  );
  const hostCenter = new URL(
    createHostCenterHref({
      adapter: productAdapter,
      returnUri: "yurume://connect",
    }),
  );
  expect(hostCenter.origin + hostCenter.pathname).toBe(
    "https://app.takosumi.com/new",
  );
  expect(hostCenter.searchParams.get("product")).toBe("yurumeet");
});

// Takosumi echoes back the catalog key it was handed, not the client key, so the
// return deep link carries `yurumeet` while the app's own product is `yurume`.
test("Yurumeet accepts the Host Center return deep link it asked for", () => {
  const handoff = takosumiAppHandoffFromSearch(
    new URL(
      createHostCenterHref({
        adapter: productAdapter,
        returnUri: "yurume://connect",
      }),
    ).search,
  );
  expect(handoff).toBeDefined();
  const returnHref = createTakosumiAppConnectHref({
    handoff: handoff!,
    hostUrl: "https://meet.example",
    setupTicket: "ticket-1",
  });
  expect(returnHref).toBeDefined();

  const payload = parseMobileConnectInput(returnHref!);
  expect(payload.hostUrl).toBe("https://meet.example");
  expect(payload.setupTicket).toBe("ticket-1");
  expect(productAdapter.acceptedConnectProducts).toContain(payload.product!);
});

test("Yurumeet depends only on the standalone shared mobile foundation", async () => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(pkg.dependencies?.["@takosjp/mobile-kit"]).toBe(
    "file:../mobile-kit",
  );
  expect(pkg.dependencies?.["takosumi-contract"]).toBeUndefined();
  expect(pkg.scripts?.bootstrap).toBe("bun install --frozen-lockfile");
});

test("Yurumeet native identity, CSP, and secure-keystore floor are product-owned", async () => {
  const config = (await Bun.file(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
  ).json()) as {
    identifier: string;
    app: {
      security: {
        csp: string | null;
        devCsp: string | null;
        freezePrototype: boolean;
      };
    };
    bundle: {
      active: boolean;
      targets?: unknown;
      android: { minSdkVersion: number };
    };
    plugins: {
      "deep-link": {
        mobile: Array<{ scheme: string[] }>;
        desktop?: unknown;
      };
    };
  };
  expect(config.identifier).toBe("com.yurumeet");
  expect(config.app.security.csp).toContain("default-src 'self'");
  expect(config.app.security.csp).toContain("object-src 'none'");
  expect(config.app.security.csp).not.toContain(" ws:");
  expect(config.app.security.devCsp).toContain(" ws:");
  expect(config.app.security.freezePrototype).toBeTrue();
  expect(config.bundle.active).toBeFalse();
  expect(config.bundle.targets).toBeUndefined();
  expect(config.bundle.android.minSdkVersion).toBe(28);
  expect(config.plugins["deep-link"].desktop).toBeUndefined();
  const pushGradle = await Bun.file(
    new URL(
      "../src-tauri/plugins/mobile-push/android/build.gradle.kts",
      import.meta.url,
    ),
  ).text();
  expect(pushGradle).toContain("androidx.appcompat:appcompat");
});

test("the release evidence template cannot be mistaken for completed evidence", async () => {
  const evidence = (await Bun.file(
    new URL(
      "../release/mobile-release-evidence.example.json",
      import.meta.url,
    ),
  ).json()) as {
    bundleId: string;
    nativeSecurity: Record<string, { result: string }>;
    mobileOidc: Record<string, { result: string }>;
    remotePush: Record<string, { result: string }>;
    signing: { android: { playAppSigning: boolean } };
    store: {
      appStore: { listingReviewed: boolean; privacyNutritionReviewed: boolean };
      googlePlay: {
        packageName: string;
        listingReviewed: boolean;
        dataSafetyReviewed: boolean;
      };
    };
    deviceSmoke: Array<{ result: string }>;
  };
  expect(evidence.bundleId).toBe("com.yurumeet");
  expect(evidence.store.googlePlay.packageName).toBe("com.yurumeet");
  expect([
    ...Object.values(evidence.nativeSecurity),
    ...Object.values(evidence.mobileOidc),
    ...Object.values(evidence.remotePush),
    ...evidence.deviceSmoke,
  ].every((entry) => entry.result === "not-run")).toBeTrue();
  expect(evidence.store.appStore.listingReviewed).toBeFalse();
  expect(evidence.store.appStore.privacyNutritionReviewed).toBeFalse();
  expect(evidence.store.googlePlay.listingReviewed).toBeFalse();
  expect(evidence.store.googlePlay.dataSafetyReviewed).toBeFalse();
  expect(evidence.signing.android.playAppSigning).toBeFalse();
});

test("authenticated host shortcuts stay native until a browser handoff exists", async () => {
  const main = await Bun.file(
    new URL("../src/main.tsx", import.meta.url),
  ).text();
  expect(main).toContain("hostActions: []");
  expect(main).not.toContain("defineMobileHostActions");
  expect(main).not.toContain("openHostRoute:");
});

test("desktop launch and packaging fail closed", async () => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as { scripts: Record<string, string> };
  expect(pkg.scripts.doctor).toContain("--mobile-only");
  expect(pkg.scripts["release:native-check"]).toContain("--mobile-only");
  expect(pkg.scripts["tauri:dev"]).not.toContain("tauri dev");
  expect(pkg.scripts["tauri:build"]).not.toContain("tauri build");
  expect(
    await Bun.file(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
    ).exists(),
  ).toBeFalse();
  const cargo = await Bun.file(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
  ).text();
  expect(cargo.split("[target.")[0]).not.toContain("tauri-plugin-");
  const rustEntry = await Bun.file(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
  ).text();
  expect(rustEntry).toContain("#[cfg(mobile)]");
  expect(rustEntry).toContain("#[cfg(not(mobile))]");
  const mobileCapability = (await Bun.file(
    new URL("../src-tauri/capabilities/mobile.json", import.meta.url),
  ).json()) as { permissions: Array<string | { identifier: string }> };
  expect(mobileCapability.permissions).toContain("core:default");
});
