import { NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression, KHRMaterialsPBRSpecularGlossiness } from "@gltf-transform/extensions";
import { dedup, draco, prune, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";

let io: NodeIO | null = null;
async function getIO() {
  if (io) return io;
  io = new NodeIO().registerExtensions([KHRDracoMeshCompression, KHRMaterialsPBRSpecularGlossiness]).registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });
  return io;
}

/** Dedup + weld + prune + Draco-compress a GLB. (KTX2 textures need the external `toktx` binary; see README.) */
export async function optimizeGlb(glb: Uint8Array): Promise<Uint8Array> {
  const io = await getIO();
  const doc = await io.readBinary(glb);
  await doc.transform(dedup(), weld(), prune(), draco({ method: "edgebreaker" }));
  return io.writeBinary(doc);
}
