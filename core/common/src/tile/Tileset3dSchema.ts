/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Tile
 */

import { RequireAtLeastOne } from "@itwin/core-bentley";

/** The schema describing a 3d tileset per the [3d tiles specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/schema/tileset.schema.json).
 */
export namespace Tileset3dSchema {
  export interface Extensions {
    [key: string]: any;
  }

  export interface TilesetProperty {
    extensions?: Extensions;
    extras?: any;
  }

  export type BoundingSphere = [
    centerX: number, centerY: number, centerZ: number, radius: number
  ];

  export type BoundingRegion = [
    west: number, south: number, east: number, north: number, minHeight: number, maxHeight: number
  ];

  export type BoundingBox = [
    centerX: number, centerY: number, centerZ: number,
    uX: number, uY: number, uZ: number,
    vX: number, vY: number, vZ: number,
    wX: number, wY: number, wZ: number,
  ];

  export type BoundingVolume = RequireAtLeastOne<{
    box?: BoundingBox;
    sphere?: BoundingSphere;
    region?: BoundingRegion;
  }>;

  export type GeometricError = number;

  export type Refinement = "ADD" | "REPLACE" | string;

  export type Transform = [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
  ];

  export interface Content extends TilesetProperty {
    uri: string;
    boundingVolume?: BoundingVolume;
  }

  export interface Tile extends TilesetProperty {
    boundingVolume: BoundingVolume;
    geometricError: GeometricError;
    viewerRequestVolume?: BoundingVolume;
    refine?: Refinement;
    transform?: Transform;
    content?: Content;
    children?: Tile[];
  }

  export interface Asset extends TilesetProperty {
    version: string;
    tilesetVersion?: string;
  }

  export interface Tileset extends TilesetProperty {
    asset: Asset;
    geometricError: GeometricError;
    properties: unknown; // currently unused.
    root: Tile;
    extensionsUsed?: string[];
    extensionsRequired?: string[];
  }
}
