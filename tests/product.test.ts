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
  expect(productAdapter.directDeployUrl).toContain(
    "deploy.workers.cloudflare.com",
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

test("Yurumeet Android identity and secure-keystore floor are product-owned", async () => {
  const config = (await Bun.file(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
  ).json()) as {
    identifier: string;
    bundle: { android: { minSdkVersion: number } };
  };
  expect(config.identifier).toBe("com.yurumeet");
  expect(config.bundle.android.minSdkVersion).toBe(28);
  const pushGradle = await Bun.file(
    new URL(
      "../src-tauri/plugins/mobile-push/android/build.gradle.kts",
      import.meta.url,
    ),
  ).text();
  expect(pushGradle).toContain("androidx.appcompat:appcompat");
});
