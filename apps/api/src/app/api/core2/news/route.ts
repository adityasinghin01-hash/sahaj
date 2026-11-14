import { handleGentleNewsQueryGet, handleMarkHurtPost } from "@/lib/core2-news";

export async function GET(request: Request): Promise<Response> {
  return handleGentleNewsQueryGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleMarkHurtPost(request);
}
