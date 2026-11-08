import { expect, test } from "bun:test";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { registerProductAndroidBack } from "../src/android-back-native.ts";

test("the real installed Tauri SDK registers and releases only Android Back", async () => {
  const names = ["window", "__TAURI_INTERNALS__", "__TAURI_EVENT_PLUGIN_INTERNALS__", "__TAURI_OS_PLUGIN_INTERNALS__"];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const calls: { command: string; event: unknown; channelId: unknown }[] = [];
  let channel: Channel<unknown> | undefined, backs = 0;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "__TAURI_OS_PLUGIN_INTERNALS__", { configurable: true, value: { platform: "android" } });
    mockIPC((command, payload) => {
      const data = payload as Record<string, unknown>;
      calls.push({ command, event: data.event, channelId: data.channelId });
      if (data.handler instanceof Channel) channel = data.handler;
    });
    const release = await registerProductAndroidBack(() => { backs++; });
    expect(calls.map((call) => call.command)).toEqual(["plugin:app|register_listener"]);
    expect(calls[0]!.event).toBe("back-button");
    expect(channel).toBeDefined();
    channel!.onmessage({ canGoBack: false });
    expect(backs).toBe(1);
    await release!();
    expect(calls[1]).toEqual({ command: "plugin:app|remove_listener", event: "back-button", channelId: channel!.id });
  } finally {
    clearMocks();
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("web and iOS do not install an Android Back listener", async () => {
  expect(await registerProductAndroidBack(() => {})).toBeUndefined();
  const names = ["window", "__TAURI_INTERNALS__", "__TAURI_OS_PLUGIN_INTERNALS__"];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "__TAURI_OS_PLUGIN_INTERNALS__", { configurable: true, value: { platform: "ios" } });
    expect(await registerProductAndroidBack(() => {})).toBeUndefined();
  } finally {
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
