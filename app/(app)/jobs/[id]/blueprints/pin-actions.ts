"use server";

import { revalidatePath } from "next/cache";
import {
  listPinsForVersion, listLinkableSnags,
  createNotePin, createSnagPin, linkSnagPin, movePin, deletePin,
  type PinResult,
} from "@/server/services/blueprint-pins";
import type {
  BlueprintPin, CreateNotePinInput, CreateSnagPinInput, LinkSnagPinInput, MovePinInput,
} from "@/lib/blueprints/pins";

/**
 * Server actions for the Blueprint Pins layer. The viewer is a client component
 * (dynamic ssr:false), so it calls these to read/mutate pins in place. Each
 * mutation revalidates the register route so a server re-render reflects it.
 */

export async function getPinsAction(versionId: string): Promise<BlueprintPin[]> {
  return listPinsForVersion(versionId);
}

export async function getLinkableSnagsAction(jobId: string): Promise<{ id: string; title: string; status: string }[]> {
  return listLinkableSnags(jobId);
}

export async function placeNotePinAction(jobId: string, input: CreateNotePinInput): Promise<PinResult> {
  const res = await createNotePin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function placeSnagPinAction(jobId: string, input: CreateSnagPinInput): Promise<PinResult> {
  const res = await createSnagPin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function linkSnagPinAction(jobId: string, input: LinkSnagPinInput): Promise<PinResult> {
  const res = await linkSnagPin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function movePinAction(jobId: string, input: MovePinInput): Promise<PinResult> {
  const res = await movePin(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function deletePinAction(jobId: string, pinId: string): Promise<PinResult> {
  const res = await deletePin(pinId);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}
