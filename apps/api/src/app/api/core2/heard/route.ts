import { handleHeardStatusGet } from "@/lib/core2-news";

export async function GET(request: Request): Promise<Response> {
  return handleHeardStatusGet(request);
}
