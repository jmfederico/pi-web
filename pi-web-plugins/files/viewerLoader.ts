import * as entryResidentViewerDependencies from "./viewerDependencies";

export type FilesViewerDependencies = typeof import("./viewerDependencies.js");

const viewerDependencies = Promise.resolve(entryResidentViewerDependencies);

/**
 * Return the entry-resident viewer graph.
 *
 * Canonical Files elements can outlive the machine registration that first
 * defined them, so editor construction must never fetch a chunk from that
 * registration's artifact root after activation.
 */
export function loadFilesViewerDependencies(): Promise<FilesViewerDependencies> {
  return viewerDependencies;
}
