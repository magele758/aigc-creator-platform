"""Local ComfyUI API graphs for Z-Image, Boogu instruction editing and Wan 2.2."""

from __future__ import annotations

import math

Z_IMAGE = "z_image_turbo_bf16.safetensors"
BOOGU = "boogu_image_edit_turbo_int8_convrot.safetensors"
WAN = "wan2.2_ti2v_5B_fp16.safetensors"
WAN_LORA = "Wan22_TI2V_5B_Turbo_lora_rank_64_fp16.safetensors"


def boogu_reference_size(width, height):
    # TextEncodeBooguEdit encodes every reference at a 1024² pixel budget,
    # aligned to the model's 16px patch grid. Match its spatial coordinates.
    scale = math.sqrt(1024**2 / (width * height))
    return max(16, round(width * scale / 16) * 16), max(16, round(height * scale / 16) * 16)


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def still(prompt, width, height, steps, seed, images, mask_image=None, edit_strength=0.97):
    graph = {"3": node("VAELoader", vae_name="ae.safetensors")}
    if images:
        graph.update(
            {
                "1": node("UNETLoader", unet_name=BOOGU, weight_dtype="default"),
                "2": node(
                    "CLIPLoader",
                    clip_name="qwen3vl_8b_fp8_scaled.safetensors",
                    type="boogu",
                    device="cpu",
                ),
                "6": node("EmptyLatentImage", width=width, height=height, batch_size=1),
            }
        )
        refs = {}
        for i, image in enumerate(images, start=1):
            key = str(20 + i)
            graph[key] = node("LoadImage", image=image)
            refs[f"images.image_{i}"] = [key, 0]
        graph["5"] = node(
            "TextEncodeBooguEdit", clip=["2", 0], vae=["3", 0], prompt=prompt, negative_prompt="", **refs
        )
        positive, negative = ["5", 0], ["5", 1]
        model, sampler, shift = BOOGU, "dpmpp_2m", 3.16
    else:
        graph.update(
            {
                "1": node("UNETLoader", unet_name=Z_IMAGE, weight_dtype="fp8_e4m3fn"),
                "2": node("CLIPLoader", clip_name="qwen_3_4b.safetensors", type="lumina2", device="cpu"),
                "5": node("CLIPTextEncode", clip=["2", 0], text=prompt),
                "4": node("CLIPTextEncode", clip=["2", 0], text=""),
                "6": node("EmptySD3LatentImage", width=width, height=height, batch_size=1),
            }
        )
        model, sampler, shift = Z_IMAGE, "euler", 3.0
        positive, negative = ["5", 0], ["4", 0]
    graph.update(
        {
            "7": node("ModelSamplingAuraFlow", model=["1", 0], shift=shift),
            "8": node(
                "KSampler",
                model=["7", 0],
                positive=positive,
                negative=negative,
                latent_image=["6", 0],
                seed=seed,
                steps=steps,
                cfg=1.0,
                sampler_name=sampler,
                scheduler="simple",
                denoise=1.0,
            ),
            "9": node("VAEDecode", samples=["8", 0], vae=["3", 0]),
            "10": node("SaveImage", images=["9", 0], filename_prefix="dieying/still"),
        }
    )
    if mask_image:
        if not images:
            raise ValueError("A local edit requires its source image")
        # Sample the original VAE latent only in the painted region. The final
        # source-space composite also protects against ordinary VAE round-trip drift.
        graph.update(
            {
                "61": node(
                    "ImageScale",
                    image=["21", 0],
                    width=width,
                    height=height,
                    upscale_method="lanczos",
                    crop="disabled",
                ),
                "62": node("VAEEncode", pixels=["61", 0], vae=["3", 0]),
                "63": node("LoadImage", image=mask_image),
                "64": node(
                    "ImageScale",
                    image=["63", 0],
                    width=width,
                    height=height,
                    upscale_method="area",
                    crop="disabled",
                ),
                "65": node("ImageToMask", image=["64", 0], channel="red"),
                "6": node("SetLatentNoiseMask", samples=["62", 0], mask=["65", 0]),
            }
        )
        graph["8"]["inputs"]["denoise"] = edit_strength
    return graph, model


def motion(prompt, width, height, steps, seed, frames, fps, first, draft=False):
    graph = {
        "1": node("UNETLoader", unet_name=WAN, weight_dtype="fp8_e4m3fn" if draft else "default"),
        "2": node(
            "CLIPLoader", clip_name="umt5_xxl_fp8_e4m3fn_scaled.safetensors", type="wan", device="cpu"
        ),
        "3": node("VAELoader", vae_name="wan2.2_vae.safetensors"),
        "5": node("CLIPTextEncode", clip=["2", 0], text=prompt),
        "6": node("CLIPTextEncode", clip=["2", 0], text="模糊，低质量，变形，字幕，水印"),
        "8": node("ModelSamplingSD3", model=["7" if draft else "1", 0], shift=8.0),
        "9": node(
            "Wan22ImageToVideoLatent",
            vae=["3", 0],
            width=width,
            height=height,
            length=frames,
            batch_size=1,
        ),
        "11": node(
            "KSampler",
            model=["8", 0],
            positive=["5", 0],
            negative=["6", 0],
            latent_image=["9", 0],
            seed=seed,
            steps=steps,
            cfg=1.0 if draft else 5.0,
            sampler_name="uni_pc",
            scheduler="simple",
            denoise=1.0,
        ),
        "12": node("VAEDecode", samples=["11", 0], vae=["3", 0]),
        "13": node("CreateVideo", images=["12", 0], fps=float(fps)),
        "10": node(
            "SaveVideo", video=["13", 0], filename_prefix="dieying/motion", format="mp4", codec="h264"
        ),
    }
    if draft:
        graph["7"] = node("LoraLoaderModelOnly", model=["1", 0], lora_name=WAN_LORA, strength_model=1.0)
    if first:
        graph["4"] = node("LoadImage", image=first)
        graph["9"]["inputs"]["start_image"] = ["4", 0]
    return graph, WAN
