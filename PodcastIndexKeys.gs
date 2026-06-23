/**
 * Configuration file for Podcast Index search engine
 *
 * What is this file for?
 * -----------------
 * The system performs a dual search – against Apple iTunes and Podcast Index.
 * To search against Podcast Index, an API key is required due to their security policies.
 * This file is intended for open-source users who downloaded the code from GitHub
 * and wish to enable the broader dual-search functionality.
 *
 * What happens if I don't add the keys (or delete this file)?
 * -----------------
 * The system will continue to work perfectly and seamlessly! It will simply fall back
 * to exclusively using the iTunes search engine, which covers the vast majority of podcasts.
 *
 * How to get a free API Key?
 * -----------------
 * 1. Visit: https://api.podcastindex.org
 * 2. Sign up / Log in.
 * 3. You will be provided with an API Key and an API Secret.
 *
 * Do I need to rename this file?
 * -----------------
 * No! Just paste your keys into the variables below (replace 'YOUR_API_KEY', etc.).
 * **Note:** Since this template file is currently listed in `.claspignore`,
 * you MUST open `.claspignore` and remove the line `PodcastIndexKeys.gs`
 * before running `clasp push`, so your keys will be uploaded to your Google Script.
 */

function getPodcastIndexKeys_Template() {
  return {
    apiKey: "YOUR_API_KEY",
    apiSecret: "YOUR_API_SECRET"
  };
}
