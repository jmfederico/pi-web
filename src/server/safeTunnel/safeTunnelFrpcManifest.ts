export type SafeTunnelFrpcArchiveFormat = "tar.gz";

export interface SafeTunnelFrpcArtifact {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly archiveFormat: SafeTunnelFrpcArchiveFormat;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly archiveEntryPath: string;
  readonly downloadUrl: string;
  readonly executableSha256: string;
  readonly executableSize: number;
}

export interface SafeTunnelFrpcManifest {
  readonly version: string;
  readonly artifacts: readonly SafeTunnelFrpcArtifact[];
}

/** The one official frpc release pinned for the Safe Tunnel MVP. */
export const safeTunnelFrpcManifest: SafeTunnelFrpcManifest = {
  version: "0.69.1",
  artifacts: [
    {
      platform: "linux",
      architecture: "arm64",
      archiveFormat: "tar.gz",
      archiveSha256: "bbc0c75e896af3f292fb46ba09c844a04fa9b5ea3530c039c7af20637f836355",
      archiveSize: 12_599_774,
      archiveEntryPath: "frp_0.69.1_linux_arm64/frpc",
      downloadUrl: "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_arm64.tar.gz",
      executableSha256: "f93e758ea21099a8ac6b65791d1113e86ccb06bab03cc41575613726e375322d",
      executableSize: 15_007_928,
    },
    {
      platform: "linux",
      architecture: "x64",
      archiveFormat: "tar.gz",
      archiveSha256: "7be257b72dbbc60bcb3e0e25a5afd1dfac7b63f897084864d3c956dd3d5674e1",
      archiveSize: 14_189_005,
      archiveEntryPath: "frp_0.69.1_linux_amd64/frpc",
      downloadUrl: "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_amd64.tar.gz",
      executableSha256: "142f447f43fef286acc8da8a6852dda80631db631d604b2e63634b2db4d6848c",
      executableSize: 16_806_072,
    },
  ],
};

export function findSafeTunnelFrpcArtifact(
  manifest: SafeTunnelFrpcManifest,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): SafeTunnelFrpcArtifact | undefined {
  return manifest.artifacts.find((artifact) => (
    artifact.platform === platform && artifact.architecture === architecture
  ));
}
