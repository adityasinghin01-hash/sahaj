import { handleTwilioHeardStatusPost } from "@/lib/core2-news";

export async function POST(request: Request): Promise<Response> {
  return handleTwilioHeardStatusPost(request);
}
