import solid from "vite-plugin-solid";
import { createTauriMobileViteConfig } from "@takosjp/mobile-kit/vite";

export default createTauriMobileViteConfig({
  devPort: 1440,
  importMetaUrl: import.meta.url,
  resolveMobileKitFromPackage: true,
  plugins: [solid()],
});
