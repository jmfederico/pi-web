import { defineConfig } from "vitest/config";
import sharedConfig from "./vitest.config.js";

// Repeat real native boundaries on Windows, not the platform-independent suite.
// Linux still runs every file below through the ordinary configuration.
export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: [
      // Native module resolution, symlinks, child startup, and build publication.
      "src/piRuntime.test.ts",
      "src/pluginRecoveryCli.test.ts",
      "scripts/dev-startup.test.mjs",
      "scripts/build-plugins.test.mjs",
      // Atomic replacement and host-native path normalization.
      "src/config.test.ts",
      "src/configSessionNamingMigration.test.ts",
      "src/serverPluginRecovery.test.ts",
      "src/server/workingDirectory.test.ts",
      "src/server/storage/navigationPreferenceStore.test.ts",
      "src/server/sessions/sessionArchiveStore.test.ts",
      "src/server/sessions/attachmentService.test.ts",
      // Real filesystem containment, junctions, mutations, and open-file races.
      "src/server/workspaces/pathAccessPolicy.test.ts",
      "src/server/workspaces/fileContentService.read.test.ts",
      "src/server/workspaces/fileContentService.write.test.ts",
      "src/server/workspaces/fileContentService.move.test.ts",
      "src/server/workspaces/fileContentService.delete.test.ts",
      "src/server/workspaces/filePreviewService.test.ts",
      "src/server/piWebPluginCatalog.test.ts",
      "src/server/piWebPluginService.test.ts",
      "pi-web-plugins/audio/server.test.ts",
      // Real Git processes, worktrees, and canonical repository paths.
      "pi-web-plugins/git/git-backend.test.ts",
      "pi-web-plugins/git/server-plugin.test.ts",
      // Process execution, named pipes/TCP, streaming, and physical teardown.
      "src/server/plugins/serverPluginExec.test.ts",
      "src/server/workspaces/workspaceNotificationCommand.test.ts",
      "src/sessiond/sessionDaemonClient.test.ts",
      "src/sessiond/sessionDaemonClient.media.test.ts",
      "src/server/pluginBackendChannel.integration.test.ts",
      "src/server/plugins/pluginResources.integration.test.ts",
    ],
  },
});
