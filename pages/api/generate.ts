import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "./auth/[...nextauth]";
import { rooms, themes } from "../../lib/prompts";
import { roomType, themeType } from "../../utils/dropdownTypes";
import prisma from "../../lib/prismadb";

export type GenerateResponseData = {
  original: string | null;
  generated: string | null;
  id: string;
};

interface ExtendedNextApiRequest extends NextApiRequest {
  body: {
    imageUrl: string;
    theme: string;
    room: string;
  };
}

export default async function handler(
  req: ExtendedNextApiRequest,
  res: NextApiResponse<GenerateResponseData | string>
) {
  // Check if user is logged in
  const session = await getServerSession(req, res, authOptions);
  if (!session || !session.user) {
    return res.status(500).json("Login to upload.");
  }

  // Get user from DB
  const user = await prisma.user.findUnique({
    where: {
      email: session.user.email!,
    },
    select: {
      credits: true,
    },
  });

  // Check if user has any credits left
  if (user?.credits === 0) {
    return res.status(400).json(`You have no generations left`);
  }

  // If they have credits, decrease their credits by one and continue
  await prisma.user.update({
    where: {
      email: session.user.email!,
    },
    data: {
      credits: {
        decrement: 1,
      },
    },
  });

  try {
    const { imageUrl, theme, room } = req.body;
    const room_prompt = rooms[room as roomType] || "a room";
    const style_prompt: string = themes[theme as themeType] || "";
    const prompt = `photorealistic picture of ${room_prompt} in ${style_prompt}`;

    // POST request to Replicate to start the image restoration generation process
    let startResponse = await fetch(
      "https://api.replicate.com/v1/predictions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Token " + process.env.REPLICATE_API_KEY,
        },
        body: JSON.stringify({
          version:
            "d55b9f2dcfb156089686b8f767776d5b61b007187a4e1e611881818098100fbb",
          input: {
            image: imageUrl,
            structure: "hough",
            prompt: prompt,
            scale: 9,
            a_prompt:
              "best quality, photo from Pinterest, interior, cinematic photo, ultra-detailed, ultra-realistic, award-winning, interior design, natural lighting",
            n_prompt:
                  "poorly drawn furniture, poorly drawn room, watermark, text, clipping objects, merging objects, blurred lines, surrealistic, messy floor, dirty, artefacts",
          },
        }),
      }
    );

    let jsonStartResponse = await startResponse.json();

    let endpointUrl = jsonStartResponse.urls.get;
    const originalImage = jsonStartResponse.input.image;
    const roomId = jsonStartResponse.id;

    // GET request to get the status of the image restoration process & return the result when it's ready
    let generatedImage: string | null = null;
    while (!generatedImage) {
      // Loop in 1s intervals until the alt text is ready
      let finalResponse = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Token " + process.env.REPLICATE_API_KEY,
        },
      });
      let jsonFinalResponse = await finalResponse.json();

      if (jsonFinalResponse.status === "succeeded") {
        generatedImage = jsonFinalResponse.output[1] as string;
      } else if (jsonFinalResponse.status === "failed") {
        break;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (generatedImage) {
      await prisma.room.create({
        data: {
          replicateId: roomId,
          user: {
            connect: {
              email: session.user.email!,
            },
          },
          inputImage: originalImage,
          outputImage: generatedImage,
          prompt: prompt,
        },
      });
    } else {
      throw new Error("Failed to restore image");
    }

    res.status(200).json(
      generatedImage
        ? {
            original: originalImage,
            generated: generatedImage,
            id: roomId,
          }
        : "Failed to restore image"
    );
  } catch (error) {
    // Increment their credit if something went wrong
    await prisma.user.update({
      where: {
        email: session.user.email!,
      },
      data: {
        credits: {
          increment: 1,
        },
      },
    });
    console.error(error);
    res.status(500).json("Failed to restore image");
  }
}
