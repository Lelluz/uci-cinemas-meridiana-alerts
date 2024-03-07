import { flatMap, pick } from "lodash-es"
import axios from "axios";
import { S3 } from "@aws-sdk/client-s3";

const s3 = new S3({ region: "eu-south-1" });
const bucketName = process.env.BUCKET_NAME;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHANNEL_CHAT_ID;
const cinemaId = process.env.CINEMA_ID;
const bearerToken = process.env.UCI_BEARER_TOKEN;

const apiUrl = `https://www.ucicinemas.it/rest/v3/cinemas/${cinemaId}/programming`;
const scrapedDataFolderPath = "scraped-data";
const updatesFolderPath = "differences-data";

function compareArray(array1, array2) {
  return array2.filter(valore => !array1.includes(valore));;
}

async function getJSON() {
  const { data: jsonData } = await axios.get(apiUrl, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });
  return jsonData;
}

async function saveToFile(data, filePath) {
  const params = {
    Bucket: bucketName,
    Key: filePath,
    Body: JSON.stringify(data, null, 2),
  };

  try {
    const response = await s3.putObject(params);
    console.log("File saved successfully.", response);
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw error;
  }
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
          performanceData: `${movie.movieId}~${event.eventId}~${event.date}~${performance.time}`
        };
      });
    });
  });
}

async function getObjectFromS3(filePath) {
  try {
    const response = await s3.getObject({ Bucket: bucketName, Key: filePath });
    return await response.Body?.transformToString();
  } catch (error) {
    console.error("Error retrieving object from S3:", error);
    throw error;
  }
}

async function compareAndSaveDifferences(newStructure, penultimateFilePath, updatesFolderPath) {
  const penultimateS3FileObj = await getObjectFromS3(penultimateFilePath);
  const penultimateDataPerformances = JSON.parse(penultimateS3FileObj).map(film => film.performanceData);
  const newStructureDataPerformances = newStructure.map(film => film.performanceData);
  const differences = compareArray(penultimateDataPerformances, newStructureDataPerformances);

  if (differences.length > 0) {
    console.log("Differences detected.");

    const differencesFullData = differences.map(difference => {
      const differenceFileds = difference.split('~');
      const movieId = parseInt(differenceFileds[0]);
      const eventId = parseInt(differenceFileds[1]);
      const date = differenceFileds[2];
      const time = differenceFileds[3];
      const movieInfoRaw = newStructure.find(film => film.movieId === movieId);
      const movieInfo = pick(movieInfoRaw, [
        "name",
        "moviePath",
        "screen",
        "webUrl",
        "buyUrl",
        "moviePosterMedium"
      ]);
      return({movieId, eventId, movieInfo, date, time});
    })

    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
    const differencesFilePath = `${updatesFolderPath}/differences_${timestamp}.json`;
    await saveToFile(differencesFullData, differencesFilePath);

    const telegramChannelMessageText = `
    È stata aggiornata la programmazione dei film all'UCI Cinemas Meridiana di Bologna! 🎥 🍿
    
    ${differencesFullData
      .map(
        (film) => `
          Film: ${film.movieInfo.movieTitle}
          Data: ${film.movieInfo.date}
          Orario: ${film.movieInfo.time}
        `
      )
      .join(`______________`)}
    `;
    await sendTelegramAlert(telegramChannelMessageText);

  } else {
    console.log("No differences found.");
  }
}

async function sendTelegramAlert(message) {
  const apiUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
  const params = {
    chat_id: telegramChatId,
    text: message,
  };

  try {
    const response = await axios.post(apiUrl, params);

    return {
      statusCode: response.status,
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    console.error("Error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
}

async function compareLatestTwoFiles (newStructure) {
  const params = {
    Bucket: bucketName,
    Prefix: scrapedDataFolderPath,
  };

  try {
    const data = await s3.listObjectsV2(params);
    const scrapedDataFiles = data.Contents.sort(
      (a, b) => b.LastModified - a.LastModified
    );
    const [latestFile, penultimateFile] = scrapedDataFiles.slice(0, 2);

    if (latestFile && penultimateFile) {
      const latestFilePath = latestFile.Key;
      const penultimateFilePath = penultimateFile.Key;

      compareAndSaveDifferences(newStructure, penultimateFilePath, updatesFolderPath);
    }
  } catch (error) {
    console.error("Error in file comparison:", error);
  }
}

export const handler = async (event) => {
  try {
      const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
      const newScrapedDataFilePath = `${scrapedDataFolderPath}/scraped-data_${timestamp}.json`;
  
    const data = await getJSON();
    const newStructure = createNewStructure(data);
    
    await saveToFile(newStructure, newScrapedDataFilePath);
    compareLatestTwoFiles(newStructure)
  } catch (error) {
    console.error("Error in Lambda function:", error);
  }
};
