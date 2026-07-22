import { GoogleGenAI } from "@google/genai";
import { getOptionalEnv } from "./env";

export function getGeminiModel() {
  return getOptionalEnv("GEMINI_MODEL") ?? "gemini-2.5-flash-lite";
}

export function createGeminiClient() {
  const apiKey = getOptionalEnv("GEMINI_API_KEY");
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}
