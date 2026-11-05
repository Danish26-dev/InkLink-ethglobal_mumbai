import * as THREE from 'three';
import { C } from '../lib/brand';

/**
 * Centralized, reusable materials for the INKLINK atelier.
 * Kept in a module so geometry/material disposal is predictable and we avoid
 * allocating duplicate materials across many object instances.
 */

export const matMatteBlack = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.ink),
  roughness: 0.62,
  metalness: 0.15,
});

export const matPaperWhite = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.paper),
  roughness: 0.85,
  metalness: 0.0,
});

export const matLightGrey = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.lightGrey),
  roughness: 0.75,
  metalness: 0.05,
});

export const matGraphite = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.graphite),
  roughness: 0.5,
  metalness: 0.3,
});

export const matSignal = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.signal),
  roughness: 0.4,
  metalness: 0.1,
  emissive: new THREE.Color(C.signal),
  emissiveIntensity: 0.0,
});

export const matSignalGlow = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.signal),
  roughness: 0.35,
  metalness: 0.0,
  emissive: new THREE.Color(C.signal),
  emissiveIntensity: 1.4,
});

export const matGlass = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color('#ffffff'),
  roughness: 0.15,
  metalness: 0,
  transmission: 0.0,
  transparent: true,
  opacity: 0.12,
  reflectivity: 0.4,
});

export const matPaperSheet = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#ffffff'),
  roughness: 0.95,
  metalness: 0,
  side: THREE.DoubleSide,
});

export const matLayer = new THREE.MeshStandardMaterial({
  color: new THREE.Color(C.paper),
  roughness: 0.6,
  metalness: 0,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
  side: THREE.DoubleSide,
});

export const matDome = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#ffffff'),
  roughness: 0.1,
  metalness: 0,
  transparent: true,
  opacity: 0.16,
  depthWrite: false,
  side: THREE.DoubleSide,
});

export function disposeSharedMaterials() {
  [
    matMatteBlack,
    matPaperWhite,
    matLightGrey,
    matGraphite,
    matSignal,
    matSignalGlow,
    matGlass,
    matPaperSheet,
  ].forEach((m) => m.dispose());
}
