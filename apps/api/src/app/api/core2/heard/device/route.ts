import { handleDeviceHeardPost } from "@/lib/core2-news";

export async function POST(request: Request): Promise<Response> {
  return handleDeviceHeardPost(request);
}
