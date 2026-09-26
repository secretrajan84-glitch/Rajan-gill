# Google Colab bulk image generation

Open [`bulk_2d_images_colab.ipynb`](bulk_2d_images_colab.ipynb) in Google Colab, select **Runtime → Change runtime type → T4 GPU**, then run all cells in order. It clones this branch from GitHub, reads all 182 prompts from [`image_prompts.txt`](image_prompts.txt), generates numbered PNG files using the public `Lykon/dreamshaper-8` Diffusers model, and saves them to `MyDrive/elephant_2d_images/`.

Change `START, END` to render in smaller batches. Completed PNGs are skipped on rerun; use `OVERWRITE=True` to regenerate them. Generation quality and available GPU time depend on Colab. The model may not render exact tag lettering, and uploaded reference images are not used automatically. Review each output before use.
