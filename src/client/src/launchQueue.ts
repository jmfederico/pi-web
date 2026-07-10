// Thin wrapper around the Launch Handler API (window.launchQueue), which
// Chrome feeds re-launches into when the manifest declares
// launch_handler.client_mode = "focus-existing" — e.g. tapping a shortcut or
// completing a share while the PWA is already open in another window. Not in
// TypeScript's lib.dom yet, hence the local shape.

export interface LaunchParams {
  readonly targetURL?: string;
}

export interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

export function installLaunchQueueConsumer(onLaunch: (url: URL) => void, windowObject: Pick<Window, "launchQueue"> = window): void {
  const queue = windowObject.launchQueue;
  if (queue === undefined) return;
  queue.setConsumer((params) => {
    if (params.targetURL === undefined) return;
    onLaunch(new URL(params.targetURL));
  });
}
