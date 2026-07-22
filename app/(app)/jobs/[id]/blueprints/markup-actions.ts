"use server";

import { revalidatePath } from "next/cache";
import {
  listMarkupForVersion, createMarkup, removeMarkup, deleteMarkup,
  type MarkupResult,
} from "@/server/services/blueprint-markup";
import type { BlueprintMarkup, CreateMarkupInput } from "@/lib/blueprints/markup";

/**
 * Server actions for the Blueprint Markup layer. The viewer is a client
 * component (dynamic ssr:false) that calls these to read/mutate redlines in
 * place. Mutations revalidate the register route.
 */

export async function getMarkupAction(versionId: string): Promise<BlueprintMarkup[]> {
  return listMarkupForVersion(versionId);
}

export async function createMarkupAction(jobId: string, input: CreateMarkupInput): Promise<MarkupResult> {
  const res = await createMarkup(input);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function removeMarkupAction(jobId: string, id: string): Promise<MarkupResult> {
  const res = await removeMarkup(id);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}

export async function deleteMarkupAction(jobId: string, id: string): Promise<MarkupResult> {
  const res = await deleteMarkup(id);
  if (res.ok) revalidatePath(`/jobs/${jobId}/blueprints`);
  return res;
}
