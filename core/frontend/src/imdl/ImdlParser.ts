/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Tiles
 */

import { assert, ByteStream, Id64String, JsonUtils, utf8ToString } from "@itwin/core-bentley";
import { Point3d, Range2d, Range3d } from "@itwin/core-geometry";
import {
  BatchType, ColorDef, ColorDefProps, FeatureTableHeader, FillFlags, GltfV2ChunkTypes, GltfVersions, Gradient, ImdlFlags, ImdlHeader, LinePixels, MultiModelPackedFeatureTable,
  PackedFeatureTable, PolylineTypeFlags, QParams2d, QParams3d, RenderFeatureTable, RenderMaterial, RenderSchedule, RenderTexture, RgbColor, RgbColorProps, TextureMapping, TileFormat,
  TileHeader, TileReadStatus,
} from "@itwin/core-common";
import { ImdlModel as Imdl } from "./ImdlModel";
import {
  AnyImdlPrimitive, ImdlAreaPattern, ImdlColorDef, ImdlDisplayParams, ImdlDocument, ImdlIndexedEdges, ImdlMesh, ImdlMeshEdges, ImdlMeshPrimitive, ImdlNamedTexture, ImdlPolyline,
  ImdlSegmentEdges, ImdlSilhouetteEdges, ImdlTextureMapping,
} from "./ImdlSchema";
import { Mesh } from "../render/primitives/mesh/MeshPrimitives";
import { createSurfaceMaterial, isValidSurfaceType } from "../render/primitives/SurfaceParams";
import { DisplayParams } from "../render/primitives/DisplayParams";
import { AuxChannelTable, AuxChannelTableProps } from "../render/primitives/AuxChannelTable";
import { splitMeshParams, splitPointStringParams, splitPolylineParams } from "../render/primitives/VertexTableSplitter";
import { AnimationNodeId } from "../render/GraphicBranch";
import { ComputeAnimationNodeId, EdgeParams, MeshParams, TesselatedPolyline, VertexIndices, VertexTable } from "../render-primitives";
import { CreateRenderMaterialArgs } from "../render/RenderMaterial";

export type ImdlTimeline = RenderSchedule.ModelTimeline | RenderSchedule.Script;

export interface ImdlParserOptions {
  stream: ByteStream;
  batchModelId: Id64String;
  is3d: boolean;
  maxVertexTableSize: number;
  omitEdges?: boolean;
  createUntransformedRootNode?: boolean;
  timeline?: ImdlTimeline;
}

/** Header preceding "glTF" data in iMdl tile. */
class GltfHeader extends TileHeader {
  public readonly gltfLength: number;
  public readonly scenePosition: number = 0;
  public readonly sceneStrLength: number = 0;
  public readonly binaryPosition: number = 0;
  public get isValid(): boolean { return TileFormat.Gltf === this.format; }

  public constructor(stream: ByteStream) {
    super(stream);
    this.gltfLength = stream.readUint32();

    this.sceneStrLength = stream.readUint32();
    const value5 = stream.readUint32();

    // Early versions of the reality data tile publisher incorrectly put version 2 into header - handle these old tiles
    // validating the chunk type.
    if (this.version === GltfVersions.Version2 && value5 === GltfVersions.Gltf1SceneFormat)
      this.version = GltfVersions.Version1;

    if (this.version === GltfVersions.Version1) {
      const gltfSceneFormat = value5;
      if (GltfVersions.Gltf1SceneFormat !== gltfSceneFormat) {
        this.invalidate();
        return;
      }

      this.scenePosition = stream.curPos;
      this.binaryPosition = stream.curPos + this.sceneStrLength;
    } else if (this.version === GltfVersions.Version2) {
      const sceneChunkType = value5;
      this.scenePosition = stream.curPos;
      stream.curPos = stream.curPos + this.sceneStrLength;
      const binaryLength = stream.readUint32();
      const binaryChunkType = stream.readUint32();
      if (GltfV2ChunkTypes.JSON !== sceneChunkType || GltfV2ChunkTypes.Binary !== binaryChunkType || 0 === binaryLength) {
        this.invalidate();
        return;
      }

      this.binaryPosition = stream.curPos;
    } else {
      this.invalidate();
    }
  }
}

type OptionalDocumentProperties = "rtcCenter" | "animationNodes";
type Document = Required<Omit<ImdlDocument, OptionalDocumentProperties>> & Pick<ImdlDocument, OptionalDocumentProperties>;

export type ImdlParseError = Exclude<TileReadStatus, TileReadStatus.Success>;

interface FeatureTableInfo {
  startPos: number;
  multiModel: boolean;
}

const nodeIdRegex = /Node_(.*)/;
function extractNodeId(nodeName: string): number {
  const match = nodeName.match(nodeIdRegex);
  assert(!!match && match.length === 2);
  if (!match || match.length !== 2)
    return 0;

  const nodeId = Number.parseInt(match[1], 10);
  assert(!Number.isNaN(nodeId));
  return Number.isNaN(nodeId) ? 0 : nodeId;
}

abstract class Texture extends RenderTexture {
  protected constructor(type: RenderTexture.Type) {
    super(type);
  }

  public abstract toImdl(): string | Gradient.SymbProps;

  public override dispose() { }
  public override get bytesUsed() { return 0; }
}

class NamedTexture extends Texture {
  public constructor(private readonly _name: string, type: RenderTexture.Type) {
    super(type);
  }

  public override toImdl(): string {
    return this._name;
  }
}

class GradientTexture extends Texture {
  public constructor(private readonly _gradient: Gradient.SymbProps) {
    super(RenderTexture.Type.Normal);
  }

  public override toImdl(): Gradient.SymbProps {
    return this._gradient;
  }
}

/** For splitMeshParams. It doesn't actually care about the properties of the material. It is merely used to:
 *  1. Ensure if input does NOT have a material atlas, every output has the same material as input; and
 *  2. If input DOES have a material atlas, we can assemble new material atlases or single RenderMaterials from the entries in that atlas for the outputs.
 */
abstract class Material extends RenderMaterial {
  public abstract toImdl(): Imdl.SurfaceMaterial;

  protected constructor() {
    super(new RenderMaterial.Params());
  }

  public static create(imdl: Imdl.SurfaceRenderMaterial) {
    return typeof imdl.material === "string" ? new NamedMaterial(imdl.material) : new UnnamedMaterial(imdl.material);
  }
}

class NamedMaterial extends Material {
  public constructor(private readonly _name: string) {
    super();
  }

  public override toImdl(): Imdl.SurfaceMaterial {
    return { isAtlas: false, material: this._name };
  }
}

class UnnamedMaterial extends Material {
  public constructor(private readonly _params: Imdl.SurfaceMaterialParams) {
    super();
  }

  public static fromArgs(args: CreateRenderMaterialArgs): Material {
    function toImdlColor(color: ColorDef | RgbColorProps | undefined): ColorDefProps | undefined {
      if (!color)
        return undefined;

      const colorDef = color instanceof ColorDef ? color : RgbColor.fromJSON(color).toColorDef();
      return colorDef.toJSON();
    }


    const params: Imdl.SurfaceMaterialParams = { alpha: args.alpha };
    if (args.diffuse) {
      if (undefined !== args.diffuse) {
        params.diffuse = {
          weight: args.diffuse.weight,
          color: toImdlColor(args.diffuse.color),
        };
      }
    }

    if (args.specular) {
      params.specular = {
        weight: args.specular.weight,
        exponent: args.specular.exponent,
        color: toImdlColor(args.specular.color),
      };
    }

    return new UnnamedMaterial(params);
  }

  public override toImdl(): Imdl.SurfaceMaterial {
    return { isAtlas: false, material: this._params };
  }
}

function toVertexTable(imdl: Imdl.VertexTable): VertexTable {
  return new VertexTable({
    ...imdl,
    uniformColor: imdl.uniformColor ? ColorDef.fromJSON(imdl.uniformColor) : undefined,
    qparams: QParams3d.fromJSON(imdl.qparams),
    uvParams: imdl.uvParams ? QParams2d.fromJSON(imdl.uvParams) : undefined,
  });
}

function fromVertexTable(table: VertexTable): Imdl.VertexTable {
  return {
    ...table,
    uniformColor: table.uniformColor?.toJSON(),
    qparams: table.qparams.toJSON(),
    uvParams: table.uvParams?.toJSON(),
  };
}

export function edgeParamsFromImdl(imdl: Imdl.EdgeParams): EdgeParams | undefined {
  return {
    ...imdl,
    segments: imdl.segments ? {
      ...imdl.segments,
      indices: new VertexIndices(imdl.segments.indices),
    } : undefined,
    silhouettes: imdl.silhouettes ? {
      ...imdl.silhouettes,
      indices: new VertexIndices(imdl.silhouettes.indices),
    } : undefined,
    polylines: imdl.polylines ? {
      ...imdl.polylines,
      indices: new VertexIndices(imdl.polylines.indices),
      prevIndices: new VertexIndices(imdl.polylines.prevIndices),
    } : undefined,
    indexed: imdl.indexed ? {
      indices: new VertexIndices(imdl.indexed.indices),
      edges: imdl.indexed.edges,
    } : undefined,
  };
}

class ImdlParser {
  private readonly _document: Document;
  private readonly _binaryData: Uint8Array;
  private readonly _options: ImdlParserOptions;
  private readonly _featureTableInfo: FeatureTableInfo;

  private get stream(): ByteStream {
    return this._options.stream;
  }

  public constructor(doc: Document, binaryData: Uint8Array, options: ImdlParserOptions, featureTableInfo: FeatureTableInfo) {
    this._document = doc;
    this._binaryData = binaryData;
    this._options = options;
    this._featureTableInfo = featureTableInfo;
  }

  public parse(): Imdl.Document | ImdlParseError {
    const featureTable = this.parseFeatureTable();
    if (!featureTable)
      return TileReadStatus.InvalidFeatureTable;

    const rtcCenter = this._document.rtcCenter ? {
      x: this._document.rtcCenter[0] ?? 0,
      y: this._document.rtcCenter[1] ?? 0,
      z: this._document.rtcCenter[2] ?? 0,
    } : undefined;

    const nodes = this.parseNodes(featureTable);
    return {
      featureTable,
      nodes,
      rtcCenter,
      binaryData: this._binaryData,
      json: this._document,
    };
  }

  private parseFeatureTable(): Imdl.FeatureTable | undefined {
    this.stream.curPos = this._featureTableInfo.startPos;
    const header = FeatureTableHeader.readFrom(this.stream);
    if (!header || 0 !== header.length % 4)
      return undefined;

    // NB: We make a copy of the sub-array because we don't want to pin the entire data array in memory.
    const numUint32s = (header.length - FeatureTableHeader.sizeInBytes) / 4;
    const packedFeatureArray = new Uint32Array(this.stream.nextUint32s(numUint32s));
    if (this.stream.isPastTheEnd)
      return undefined;

    let featureTable: Imdl.FeatureTable;
    if (this._featureTableInfo.multiModel) {
      featureTable = {
        multiModel: true,
        data: packedFeatureArray,
        numFeatures: header.count,
        numSubCategories: header.numSubCategories,
      };
    } else {
      let animNodesArray: Uint8Array | Uint16Array | Uint32Array | undefined;
      const animationNodes = this._document.animationNodes;
      if (undefined !== animationNodes) {
        const bytesPerId = JsonUtils.asInt(animationNodes.bytesPerId);
        const bufferViewId = JsonUtils.asString(animationNodes.bufferView);
        const bufferViewJson = this._document.bufferViews[bufferViewId];
        if (undefined !== bufferViewJson) {
          const byteOffset = JsonUtils.asInt(bufferViewJson.byteOffset);
          const byteLength = JsonUtils.asInt(bufferViewJson.byteLength);
          const bytes = this._binaryData.subarray(byteOffset, byteOffset + byteLength);
          switch (bytesPerId) {
            case 1:
              animNodesArray = new Uint8Array(bytes);
              break;
            case 2:
              // NB: A *copy* of the subarray.
              animNodesArray = Uint16Array.from(new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
              break;
            case 4:
              // NB: A *copy* of the subarray.
              animNodesArray = Uint32Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
              break;
          }
        }
      }

      featureTable = {
        multiModel: false,
        data: packedFeatureArray,
        numFeatures: header.count,
        animationNodeIds: animNodesArray,
      };
    }

    this.stream.curPos = this._featureTableInfo.startPos + header.length;
    return featureTable;
  }

  private parseNodes(featureTable: Imdl.FeatureTable): Imdl.Node[] {
    const nodes: Imdl.Node[] = [];
    const docNodes = this._document.nodes;
    const docMeshes = this._document.meshes;
    if (undefined === docNodes.Node_Root) {
      // A veeeery early version of the tile format (prior to introduction of schedule animation support) just supplied a flat list of meshes.
      // We shall never encounter such tiles again.
      return nodes;
    }

    for (const nodeKey of Object.keys(docNodes)) {
      const docNode = this._document.nodes[nodeKey];
      assert(undefined !== docNode); // we're iterating the keys...
      const docMesh = docMeshes[docNode];
      const docPrimitives = docMesh?.primitives;
      if (!docPrimitives)
        continue;

      const layerId = docMesh.layer;
      if ("Node_Root" === nodeKey) {
        if (this._options.timeline) {
          // Split up the root node into transform nodes.
          this.parseAnimationBranches(nodes, docMesh, featureTable, this._options.timeline);
        } else if (this._options.createUntransformedRootNode) {
          // If transform nodes exist in the tile tree, then we need to create a branch for the root node so that elements not associated with
          // any node in the schedule script can be grouped together.
          nodes.push({
            animationNodeId: AnimationNodeId.Untransformed,
            primitives: this.parsePrimitives(docPrimitives),
          });
        } else {
          nodes.push({ primitives: this.parsePrimitives(docPrimitives) });
        }
      } else if (undefined === layerId) {
        nodes.push({
          animationNodeId: extractNodeId(nodeKey),
          animationId: `${this._options.batchModelId}_${nodeKey}`,
          primitives: this.parsePrimitives(docPrimitives),
        });
      } else {
        nodes.push({
          layerId,
          primitives: this.parsePrimitives(docPrimitives),
        });
      }
    }

    return nodes;
  }

  private parseAnimationBranches(output: Imdl.Node[], docMesh: ImdlMesh, imdlFeatureTable: Imdl.FeatureTable, timeline: ImdlTimeline): void {
    const docPrimitives = docMesh.primitives;
    if (!docPrimitives)
      return;

    const nodesById = new Map<number, Imdl.AnimationNode>();
    const getNode = (nodeId: number): Imdl.AnimationNode => {
      let node = nodesById.get(nodeId);
      if (!node) {
        node =  {
          animationNodeId: nodeId,
          animationId: `${this._options.batchModelId}_Node_${nodeId}`,
          primitives: [],
        };

        nodesById.set(nodeId, node);
        output.push(node);
      }

      return node;
    };

    // NB: The BatchType is irrelevant - just use Primary.
    assert(undefined === imdlFeatureTable.animationNodeIds);
    const featureTable = convertFeatureTable(imdlFeatureTable, this._options.batchModelId);
    featureTable.populateAnimationNodeIds((feature) => timeline.getBatchIdForFeature(feature), timeline.maxBatchId);
    imdlFeatureTable.animationNodeIds = featureTable.animationNodeIds;

    const discreteNodeIds = timeline.discreteBatchIds;
    const computeNodeId: ComputeAnimationNodeId = (featureIndex) => {
      const nodeId = featureTable.getAnimationNodeId(featureIndex);
      return 0 !== nodeId && discreteNodeIds.has(nodeId) ? nodeId : 0;
    };

    const splitArgs = {
      maxDimension: this._options.maxVertexTableSize,
      computeNodeId,
      featureTable,
    };

    for (const docPrimitive of docPrimitives) {
      const primitive = this.parsePrimitive(docPrimitive);
      if (!primitive)
        continue;

      switch (primitive.type) {
        // ###TODO area patterns
        case "mesh": {
          const mesh = primitive.params;
          const material = mesh.surface.material;
          const texMap = mesh.surface.textureMapping;
          const params: MeshParams = {
            vertices: toVertexTable(primitive.params.vertices),
            surface: {
              ...primitive.params.surface,
              indices: new VertexIndices(primitive.params.surface.indices),
              material: material?.isAtlas ? material : (material ? { isAtlas: false, material: Material.create(material) } : undefined),
              textureMapping: texMap ? {
                alwaysDisplayed: texMap.alwaysDisplayed,
                // The texture type doesn't actually matter here.
                texture: typeof texMap.texture === "string" ? new NamedTexture(texMap.texture, RenderTexture.Type.Normal) : new GradientTexture(texMap.texture),
              } : undefined,
            },
            edges: primitive.params.edges ? edgeParamsFromImdl(primitive.params.edges) : undefined,
            isPlanar: primitive.params.isPlanar,
            auxChannels: primitive.params.auxChannels ? AuxChannelTable.fromJSON(primitive.params.auxChannels) : undefined,
          };

          const split = splitMeshParams({
            ...splitArgs,
            params,
            createMaterial: (args) => UnnamedMaterial.fromArgs(args),
          });
          // for (const [nodeId, params] of split) {
          //   getNode(nodeId).primitives.push({
          //     type: "mesh",
          //     params: {
          //       vertices: fromVertexTable(params.vertices),
          //       
          // }

          break;
        }
        case "point": {
          const params = {
            vertices: toVertexTable(primitive.params.vertices),
            indices: new VertexIndices(primitive.params.indices),
            weight: primitive.params.weight,
          };

          const split = splitPointStringParams({ ...splitArgs, params });
          for (const [nodeId, params] of split) {
            getNode(nodeId).primitives.push({
              type: "point",
              params: {
                vertices: fromVertexTable(params.vertices),
                indices: params.indices.data,
                weight: params.weight,
              },
            });
          }

          break;
        }
        case "polyline": {
          const params = {
            ...primitive.params,
            vertices: toVertexTable(primitive.params.vertices),
            polyline: {
              indices: new VertexIndices(primitive.params.polyline.indices),
              prevIndices: new VertexIndices(primitive.params.polyline.prevIndices),
              nextIndicesAndParams: primitive.params.polyline.nextIndicesAndParams,
            },
          };

          const split = splitPolylineParams({ ...splitArgs, params });
          for (const [nodeId, params] of split) {
            getNode(nodeId).primitives.push({
              type: "polyline",
              params: {
                ...params,
                vertices: fromVertexTable(params.vertices),
                polyline: {
                  indices: params.polyline.indices.data,
                  prevIndices: params.polyline.prevIndices.data,
                  nextIndicesAndParams: params.polyline.nextIndicesAndParams,
                },
              },
            });
          }

          break;
        }
      }
    }
  }

  private parsePrimitives(docPrimitives: Array<AnyImdlPrimitive | ImdlAreaPattern>): Imdl.Primitive[] {
    const primitives = [];
    for (const docPrimitive of docPrimitives) {
      const primitive = this.parsePrimitive(docPrimitive);
      if (primitive)
        primitives.push(primitive);
    }

    return primitives;
  }

  private parseTesselatedPolyline(json: ImdlPolyline): Imdl.TesselatedPolyline | undefined {
    const indices = this.findBuffer(json.indices);
    const prevIndices = this.findBuffer(json.prevIndices);
    const nextIndicesAndParams = this.findBuffer(json.nextIndicesAndParams);

    return indices && prevIndices && nextIndicesAndParams ? { indices, prevIndices, nextIndicesAndParams } : undefined;
  }

  private parseSegmentEdges(imdl: ImdlSegmentEdges): Imdl.SegmentEdgeParams | undefined {
    const indices = this.findBuffer(imdl.indices);
    const endPointAndQuadIndices = this.findBuffer(imdl.endPointAndQuadIndices);
    return indices && endPointAndQuadIndices ? { indices, endPointAndQuadIndices } : undefined;
  }

  private parseSilhouetteEdges(imdl: ImdlSilhouetteEdges): Imdl.SilhouetteParams | undefined {
    const segments = this.parseSegmentEdges(imdl);
    const normalPairs = this.findBuffer(imdl.normalPairs);
    return segments && normalPairs ? { ...segments, normalPairs } : undefined;
  }

  private parseIndexedEdges(imdl: ImdlIndexedEdges) : Imdl.IndexedEdgeParams | undefined {
    const indices = this.findBuffer(imdl.indices);
    const edgeTable = this.findBuffer(imdl.edges);
    if (!indices || !edgeTable)
      return undefined;

    return {
      indices,
      edges: {
        data: edgeTable,
        width: imdl.width,
        height: imdl.height,
        silhouettePadding: imdl.silhouettePadding,
        numSegments: imdl.numSegments,
      },
    };
  }

  private parseEdges(imdl: ImdlMeshEdges | undefined, displayParams: DisplayParams): Imdl.EdgeParams | undefined {
    if (!imdl)
      return undefined;

    const segments = imdl.segments ? this.parseSegmentEdges(imdl.segments) : undefined;
    const silhouettes = imdl.silhouettes ? this.parseSilhouetteEdges(imdl.silhouettes) : undefined;
    const indexed = imdl.indexed ? this.parseIndexedEdges(imdl.indexed) : undefined;
    const polylines = imdl.polylines ? this.parseTesselatedPolyline(imdl.polylines) : undefined;

    if (!segments && !silhouettes && !indexed &&!polylines)
      return undefined;

    return {
      segments,
      silhouettes,
      polylines,
      indexed,
      weight: displayParams.width,
      linePixels: displayParams.linePixels,
    };
  }

  private parsePrimitive(docPrimitive: AnyImdlPrimitive | ImdlAreaPattern): Imdl.Primitive | undefined {
    if (docPrimitive.type === "areaPattern")
      return undefined; // ###TODO

    let modifier: Imdl.PrimitiveModifier | undefined = this.parseInstances(docPrimitive);
    if (!modifier && docPrimitive.viewIndependentOrigin) {
      const origin = Point3d.fromJSON(docPrimitive.viewIndependentOrigin);
      modifier = {
        type: "viewIndependentOrigin",
        origin: { x: origin.x, y: origin.y, z: origin.z },
      };
    }

    const materialName = docPrimitive.material ?? "";
    const dpMaterial = materialName.length ? JsonUtils.asObject(this._document.materials[materialName]) : undefined;
    const displayParams = dpMaterial ? this.parseDisplayParams(dpMaterial) : undefined;
    if (!displayParams)
      return undefined;

    const vertices = this.parseVertexTable(docPrimitive);
    if (!vertices)
      return undefined;

    let primitive: Imdl.Primitive | undefined;
    const isPlanar = !this._options.is3d || JsonUtils.asBool(docPrimitive.isPlanar);
    switch (docPrimitive.type) {
      case Mesh.PrimitiveType.Mesh: {
        const surface = this.parseSurface(docPrimitive, displayParams);
        if (surface) {
          primitive = {
            type: "mesh",
            params: {
              vertices,
              surface,
              isPlanar,
              auxChannels: this.parseAuxChannelTable(docPrimitive),
              edges: this.parseEdges(docPrimitive.edges, displayParams),
            },
          };
        }

        break;
      }
      case Mesh.PrimitiveType.Polyline: {
        const polyline = this.parseTesselatedPolyline(docPrimitive);
        if (polyline) {
          let type = PolylineTypeFlags.Normal;
          if (DisplayParams.RegionEdgeType.Outline === displayParams.regionEdgeType)
            type = (!displayParams.gradient || displayParams.gradient.isOutlined) ? PolylineTypeFlags.Edge : PolylineTypeFlags.Outline;

          primitive = {
            type: "polyline",
            params: {
              vertices,
              polyline,
              isPlanar,
              type,
              weight: displayParams.width,
              linePixels: displayParams.linePixels,
            },
          };
        }

        break;
      }
      case Mesh.PrimitiveType.Point: {
        const indices = this.findBuffer(docPrimitive.indices);
        const weight = displayParams.width;
        if (indices) {
          primitive = {
            type: "point",
            params: { vertices, indices, weight },
          };
        }

        break;
      }
    }

    if (primitive)
      primitive.modifier = modifier;

    return primitive;
  }

  private parseSurface(mesh: ImdlMeshPrimitive, displayParams: DisplayParams): Imdl.SurfaceParams | undefined {
    const surf = mesh.surface;
    if (!surf)
      return undefined;

    const indices = this.findBuffer(surf.indices);
    if (!indices)
      return undefined;

    const type = surf.type;
    if (!isValidSurfaceType(type))
      return undefined;

    const texture = displayParams.textureMapping?.texture;
    let material: Imdl.SurfaceMaterial | undefined;
    const atlas = mesh.vertices.materialAtlas;
    const numColors = mesh.vertices.numColors;
    if (atlas && numColors) {
      material = {
        isAtlas: true,
        hasTranslucency: JsonUtils.asBool(atlas.hasTranslucency),
        overridesAlpha: JsonUtils.asBool(atlas.overridesAlpha, false),
        vertexTableOffset: JsonUtils.asInt(numColors),
        numMaterials: JsonUtils.asInt(atlas.numMaterials),
      };
    } else if (displayParams.material) {
      assert(displayParams.material instanceof Material);
      material = displayParams.material.toImdl();
    }

    let textureMapping;
    if (texture) {
      assert(texture instanceof Texture);
      textureMapping = {
        texture: texture.toImdl(),
        alwaysDisplayed: JsonUtils.asBool(surf.alwaysDisplayTexture),
      };
    }

    return {
      type,
      indices,
      fillFlags: displayParams.fillFlags,
      hasBakedLighting: false,
      material,
      textureMapping,
    };
  }

  private parseAuxChannelTable(primitive: ImdlMeshPrimitive): AuxChannelTableProps | undefined {
    const json = primitive.auxChannels;
    if (undefined === json)
      return undefined;

    const bytes = this.findBuffer(JsonUtils.asString(json.bufferView));
    if (undefined === bytes)
      return undefined;

    return {
      data: bytes,
      width: json.width,
      height: json.height,
      count: json.count,
      numBytesPerVertex: json.numBytesPerVertex,
      displacements: json.displacements,
      normals: json.normals,
      params: json.params,
    };
  }

  private parseVertexTable(primitive: AnyImdlPrimitive): Imdl.VertexTable | undefined {
    const json = primitive.vertices;
    if (!json)
      return undefined;

    const bytes = this.findBuffer(JsonUtils.asString(json.bufferView));
    if (!bytes)
      return undefined;

    const uniformFeatureID = undefined !== json.featureID ? JsonUtils.asInt(json.featureID) : undefined;

    const rangeMin = JsonUtils.asArray(json.params.decodedMin);
    const rangeMax = JsonUtils.asArray(json.params.decodedMax);
    if (undefined === rangeMin || undefined === rangeMax)
      return undefined;

    const qparams = QParams3d.fromRange(Range3d.create(Point3d.create(rangeMin[0], rangeMin[1], rangeMin[2]), Point3d.create(rangeMax[0], rangeMax[1], rangeMax[2])));

    const uniformColor = undefined !== json.uniformColor ? ColorDef.fromJSON(json.uniformColor) : undefined;
    let uvParams: QParams2d | undefined;
    if (Mesh.PrimitiveType.Mesh === primitive.type && primitive.surface && primitive.surface.uvParams) {
      const uvMin = primitive.surface.uvParams.decodedMin;
      const uvMax = primitive.surface.uvParams.decodedMax;
      const uvRange = new Range2d(uvMin[0], uvMin[1], uvMax[0], uvMax[1]);
      uvParams = QParams2d.fromRange(uvRange);
    }

    return {
      data: bytes,
      usesUnquantizedPositions: true === json.usesUnquantizedPositions,
      qparams: qparams.toJSON(),
      width: json.width,
      height: json.height,
      hasTranslucency: json.hasTranslucency,
      uniformColor: uniformColor?.toJSON(),
      featureIndexType: json.featureIndexType,
      uniformFeatureID,
      numVertices: json.count,
      numRgbaPerVertex: json.numRgbaPerVertex,
      uvParams: uvParams?.toJSON(),
    };
  }

  private parseInstances(primitive: AnyImdlPrimitive): Imdl.Instances | undefined {
    const json = primitive.instances;
    if (!json)
      return undefined;

    const count = JsonUtils.asInt(json.count, 0);
    if (count <= 0)
      return undefined;

    const centerComponents = JsonUtils.asArray(json.transformCenter);
    if (undefined === centerComponents || 3 !== centerComponents.length)
      return undefined;

    const transformCenter = Point3d.create(centerComponents[0], centerComponents[1], centerComponents[2]);

    const featureIds = this.findBuffer(JsonUtils.asString(json.featureIds));
    if (undefined === featureIds)
      return undefined;

    const transformBytes = this.findBuffer(JsonUtils.asString(json.transforms));
    if (undefined === transformBytes)
      return undefined;

    // 1 transform = 3 rows of 4 floats = 12 floats per instance
    const numFloats = transformBytes.byteLength / 4;
    assert(Math.floor(numFloats) === numFloats);
    assert(0 === numFloats % 12);

    const transforms = new Float32Array(transformBytes.buffer, transformBytes.byteOffset, numFloats);

    let symbologyOverrides: Uint8Array | undefined;
    if (undefined !== json.symbologyOverrides)
      symbologyOverrides = this.findBuffer(JsonUtils.asString(json.symbologyOverrides));

    return {
      type: "instances",
      count,
      transforms,
      transformCenter,
      featureIds,
      symbologyOverrides,
    };
  }

  private findBuffer(bufferViewId: string): Uint8Array | undefined {
    if (typeof bufferViewId !== "string" || 0 === bufferViewId.length)
      return undefined;

    const bufferViewJson = this._document.bufferViews[bufferViewId];
    if (undefined === bufferViewJson)
      return undefined;

    const byteOffset = JsonUtils.asInt(bufferViewJson.byteOffset);
    const byteLength = JsonUtils.asInt(bufferViewJson.byteLength);
    if (0 === byteLength)
      return undefined;

    return this._binaryData.subarray(byteOffset, byteOffset + byteLength);
  }

  private colorDefFromMaterialJson(json: ImdlColorDef | undefined): ColorDef | undefined {
    return undefined !== json ? ColorDef.from(json[0] * 255 + 0.5, json[1] * 255 + 0.5, json[2] * 255 + 0.5) : undefined;
  }

  private materialFromJson(key: string): RenderMaterial | undefined {
    const json = this._document.renderMaterials[key];
    if (!json)
      return undefined;

    return new UnnamedMaterial({
      alpha: undefined !== json.transparency ? 1.0 - json.transparency : undefined,
      diffuse: {
        color: this.colorDefFromMaterialJson(json.diffuseColor)?.toJSON(),
        weight: json.diffuse,
      },
      specular: {
        color: this.colorDefFromMaterialJson(json.specularColor)?.toJSON(),
        weight: json.specular,
        exponent: json.specularExponent,
      },
    });
  }

  private parseNamedTexture(namedTex: ImdlNamedTexture, name: string): RenderTexture | undefined {
    const textureType = JsonUtils.asBool(namedTex.isGlyph) ? RenderTexture.Type.Glyph :
      (JsonUtils.asBool(namedTex.isTileSection) ? RenderTexture.Type.TileSection : RenderTexture.Type.Normal);

    return new NamedTexture(name, textureType);
  }

  private parseConstantLodProps(propsJson: { repetitions?: number, offset?: number[], minDistClamp?: number, maxDistClamp?: number } | undefined): TextureMapping.ConstantLodParamProps | undefined {
    if (undefined === propsJson)
      return undefined;

    return {
      repetitions: JsonUtils.asDouble(propsJson.repetitions, 1.0),
      offset: { x: propsJson.offset ? JsonUtils.asDouble(propsJson.offset[0]) : 0.0, y: propsJson.offset ? JsonUtils.asDouble(propsJson.offset[1]) : 0.0 },
      minDistClamp: JsonUtils.asDouble(propsJson.minDistClamp, 1.0),
      maxDistClamp: JsonUtils.asDouble(propsJson.maxDistClamp, 4096.0 * 1024.0 * 1024.0),
    };
  }

  private textureMappingFromJson(json: ImdlTextureMapping | undefined): TextureMapping | undefined {
    if (!json)
      return undefined;

    const name = JsonUtils.asString(json.name);
    const namedTex = 0 !== name.length ? this._document.namedTextures[name] : undefined;
    const texture = namedTex ? this.parseNamedTexture(namedTex, name) : undefined;
    if (!texture)
      return undefined;

    const paramsJson = json.params;
    const tf = paramsJson.transform;
    const paramProps: TextureMapping.ParamProps = {
      textureMat2x3: new TextureMapping.Trans2x3(tf[0][0], tf[0][1], tf[0][2], tf[1][0], tf[1][1], tf[1][2]),
      textureWeight: JsonUtils.asDouble(paramsJson.weight, 1.0),
      mapMode: JsonUtils.asInt(paramsJson.mode),
      worldMapping: JsonUtils.asBool(paramsJson.worldMapping),
      useConstantLod: JsonUtils.asBool(paramsJson.useConstantLod),
      constantLodProps: this.parseConstantLodProps(paramsJson.constantLodParams),
    };

    const textureMapping = new TextureMapping(texture, new TextureMapping.Params(paramProps));

    const normalMapJson = json.normalMapParams;
    if (normalMapJson) {
      const normalTexName = JsonUtils.asString(normalMapJson.textureName);
      const namedNormalTex = normalTexName.length > 0 ? this._document.namedTextures[normalTexName] : undefined;
      const normalMap = namedNormalTex ? this.parseNamedTexture(namedNormalTex, normalTexName) : undefined;
      if (normalMap) {
        textureMapping.normalMapParams = {
          normalMap,
          greenUp: JsonUtils.asBool(normalMapJson.greenUp),
          scale: JsonUtils.asDouble(normalMapJson.scale, 1),
          useConstantLod: JsonUtils.asBool(normalMapJson.useConstantLod),
        };
      }
    }

    return textureMapping;
  }

  private parseDisplayParams(json: ImdlDisplayParams): DisplayParams | undefined {
    const type = JsonUtils.asInt(json.type, DisplayParams.Type.Mesh);
    const lineColor = ColorDef.create(JsonUtils.asInt(json.lineColor));
    const fillColor = ColorDef.create(JsonUtils.asInt(json.fillColor));
    const width = JsonUtils.asInt(json.lineWidth);
    const linePixels = JsonUtils.asInt(json.linePixels, LinePixels.Solid);
    const fillFlags = JsonUtils.asInt(json.fillFlags, FillFlags.None);
    const ignoreLighting = JsonUtils.asBool(json.ignoreLighting);

    // Material will always contain its own texture if it has one
    const materialKey = json.materialId;
    const material = undefined !== materialKey ? this.materialFromJson(materialKey) : undefined;

    // We will only attempt to include the texture if material is undefined
    let textureMapping;
    let gradient: Gradient.Symb | undefined;
    if (!material) {
      const textureJson = json.texture;
      textureMapping = undefined !== textureJson ? this.textureMappingFromJson(textureJson) : undefined;

      if (undefined === textureMapping) {
        const gradientProps = json.gradient;
        gradient = undefined !== gradientProps ? Gradient.Symb.fromJSON(gradientProps) : undefined;
        if (gradient) {
          assert(undefined !== gradientProps);
          const texture = new GradientTexture(gradientProps);
          textureMapping = new TextureMapping(texture, new TextureMapping.Params({ textureMat2x3: new TextureMapping.Trans2x3(0, 1, 0, 1, 0, 0) }));
        }
      }
    }

    return new DisplayParams(type, lineColor, fillColor, width, linePixels, fillFlags, material, gradient, ignoreLighting, textureMapping);
  }
}

export function convertFeatureTable(imdlFeatureTable: Imdl.FeatureTable, batchModelId: Id64String): RenderFeatureTable {
  if (!imdlFeatureTable.multiModel)
    return new PackedFeatureTable(imdlFeatureTable.data, batchModelId, imdlFeatureTable.numFeatures, BatchType.Primary);

  return MultiModelPackedFeatureTable.create(imdlFeatureTable.data, batchModelId, imdlFeatureTable.numFeatures, BatchType.Primary, imdlFeatureTable.numSubCategories);
}

export function parseImdlDocument(options: ImdlParserOptions): Imdl.Document | ImdlParseError {
  const stream = options.stream;
  const imdlHeader = new ImdlHeader(stream);
  if (!imdlHeader.isValid)
    return TileReadStatus.InvalidHeader;
  else if (!imdlHeader.isReadableVersion)
    return TileReadStatus.NewerMajorVersion;

  // Skip the feature table - we need to parse the JSON segment first to access its animationNodeIds.
  const ftStartPos = stream.curPos;
  const ftHeader = FeatureTableHeader.readFrom(stream);
  if (!ftHeader)
    return TileReadStatus.InvalidFeatureTable;

  stream.curPos = ftStartPos + ftHeader.length;

  // A glTF header follows the feature table
  const gltfHeader = new GltfHeader(stream);
  if (!gltfHeader.isValid)
    return TileReadStatus.InvalidTileData;

  stream.curPos = gltfHeader.scenePosition;
  const sceneStrData = stream.nextBytes(gltfHeader.sceneStrLength);
  const sceneStr = utf8ToString(sceneStrData);
  if (!sceneStr)
    return TileReadStatus.InvalidScene;

  try {
    const sceneValue = JSON.parse(sceneStr);
    const imdlDoc: Document = {
      scene: JsonUtils.asString(sceneValue.scene),
      scenes: JsonUtils.asArray(sceneValue.scenes),
      animationNodes: JsonUtils.asObject(sceneValue.animationNodes),
      bufferViews: JsonUtils.asObject(sceneValue.bufferViews) ?? { },
      meshes: JsonUtils.asObject(sceneValue.meshes),
      nodes: JsonUtils.asObject(sceneValue.nodes) ?? { },
      materials: JsonUtils.asObject(sceneValue.materials) ?? { },
      renderMaterials: JsonUtils.asObject(sceneValue.renderMaterials) ?? { },
      namedTextures: JsonUtils.asObject(sceneValue.namedTextures) ?? { },
      patternSymbols: JsonUtils.asObject(sceneValue.patternSymbols) ?? { },
      rtcCenter: JsonUtils.asArray(sceneValue.rtcCenter),
    };

    if (!imdlDoc.meshes)
      return TileReadStatus.InvalidTileData;

    const binaryData = new Uint8Array(stream.arrayBuffer, gltfHeader.binaryPosition);
    const featureTable = {
      startPos: ftStartPos,
      multiModel: 0 !== (imdlHeader.flags & ImdlFlags.MultiModelFeatureTable),
    };

    const parser = new ImdlParser(imdlDoc, binaryData, options, featureTable);
    return parser.parse();
  } catch (_) {
    return TileReadStatus.InvalidTileData;
  }
}
