import axios from "axios";
import fs from "fs";
import path from "path";
import { isEqual, flatMap, differenceWith } from "lodash-es"

const cinemaId = "4" /* Meridiana - Bologna */
const apiUrl = `https://www.ucicinemas.it/rest/v3/cinemas/${cinemaId}/programming`;
const scrapedDataFolderPath = "scraped-data";
const updatesFolderPath = "differences-data";
const bearerToken = "SkAkzoScIbhb3uNcGdk8UL0XMIbvs5";

async function getJSON() {
  const { data: jsonData } = await axios.get(apiUrl, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });
  return jsonData;
}

function saveToFile(data, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function createNewStructure(apiResponse) {
  return flatMap(apiResponse, (movie) => {
    return flatMap(movie.events, (event) => {
      return event.performances.map((performance) => {
        return {
          movieId: movie.movieId,
          eventId: event.eventId,
          name: movie.name,
          isPurchasable: movie.isPurchasable,
          firstPerformance: movie.firstPerformance,
          date: event.date,
          time: performance.time,
          movieNew: event.movieNew,
          moviePath: event.moviePath,
          screen: performance.screen,
          webUrl: event.webUrl,
          buyUrl: performance.buyUrl,
          moviePosterMedium: movie.moviePosterMedium,
        };
      });
    });
  });
}

function compareAndSaveDifferences(newStructure, penultimateFilePath, updatesFolderPath) {
  if (fs.existsSync(penultimateFilePath)) {
    const penultimateData = JSON.parse(fs.readFileSync(penultimateFilePath));
    const differences = differenceWith(newStructure, penultimateData, isEqual);

    if (differences.length > 0) {
      console.log("Differences detected.");

      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\./g, "-");
      const differencesFilePath = path.join(
        updatesFolderPath,
        `differences_${timestamp}.json`
      );

      fs.writeFileSync(
        differencesFilePath,
        JSON.stringify(differences, null, 2)
      );
    } else {
      console.log("No differences found.");
    }
  } else {
    console.log("No previous data for comparison.");
  }
}

if (!fs.existsSync(scrapedDataFolderPath)) {
  fs.mkdirSync(scrapedDataFolderPath);
}
if (!fs.existsSync(updatesFolderPath)) {
  fs.mkdirSync(updatesFolderPath);
}

const timestamp = new Date()
  .toISOString()
  .replace(/:/g, "-")
  .replace(/\./g, "-");
const newScrapedDataFilePath = path.join(
  scrapedDataFolderPath,
  `scraped-data_${timestamp}.json`
);

getJSON().then((data) => {
  const newStructure = createNewStructure(data);
  saveToFile(newStructure, newScrapedDataFilePath);

  const scrapedDataFiles = fs.readdirSync(scrapedDataFolderPath);
  const sortedFiles = scrapedDataFiles
    .map((filename) => ({
      name: filename,
      time: fs.statSync(path.join(scrapedDataFolderPath, filename)).birthtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  const [latestFile, penultimateFile] = sortedFiles.slice(0, 2);

  if (sortedFiles.length > 1) {
    const penultimateFilePath = path.join(scrapedDataFolderPath, penultimateFile.name);
    compareAndSaveDifferences(newStructure, penultimateFilePath, updatesFolderPath);
  }
});