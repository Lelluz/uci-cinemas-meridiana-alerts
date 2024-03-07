import { flatMap, pick } from "lodash-es"
import axios from "axios";
import { S3 } from "@aws-sdk/client-s3";
import moment from "moment"

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
          moviePosterOriginal: movie.moviePosterOriginal,
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

async function compareAndSaveDifferences(newStructure, penultimateFilePath) {
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
        "webUrl",
        "moviePosterOriginal"
      ]);
      return({movieId, eventId, movieInfo, date, time});
    })

    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");

    await saveToFile(differencesFullData, `${updatesFolderPath}/differences_${timestamp}.json`);

    differencesFullData.forEach(async film => {
      const telegramChannelMessageText =
      `${film.movieInfo.name}

Data: ${new Date(film.date).toLocaleDateString('it-IT')}
Orario: ${film.time}

${film.movieInfo.webUrl}
`;
      await sendTelegramAlert(telegramChannelMessageText, film.movieInfo.moviePosterOriginal);
    });
  } else {
    console.log("No differences found.");
  }
}

async function sendTelegramAlert(message, photoUrl) {
  const apiUrl = `https://api.telegram.org/bot${telegramToken}/sendPhoto`;
  const params = {
    chat_id: telegramChatId,
    photo: photoUrl,
    caption: message,
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

      compareAndSaveDifferences(newStructure, penultimateFilePath);
    }
  } catch (error) {
    console.error("Error in file comparison:", error);
  }
}

async function deleteAllOldFilesInFolder(folderPath) {
  try {
    const objects = await s3.listObjectsV2({ Bucket: bucketName, Prefix: folderPath });
    const oneHourAgo = moment().subtract(1, 'hours');

    for (const obj of objects.Contents || []) {
        const lastModified = moment(obj.LastModified);

        if (lastModified.isBefore(oneHourAgo)) {
            await s3.deleteObject({ Bucket: bucketName, Key: obj.Key });
        }
    }

    console.log('File eliminati con successo.');
    return {
        statusCode: 200,
        body: JSON.stringify('Operazione completata con successo.'),
    };
  } catch (error) {
      console.error('Errore durante l\'eliminazione dei file:', error);
      return {
          statusCode: 500,
          body: JSON.stringify('Errore durante l\'eliminazione dei file.'),
      };
  }
}

export const handler = async (event) => {
  try {
      const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
      const newScrapedDataFilePath = `${scrapedDataFolderPath}/scraped-data_${timestamp}.json`;
  
    const allData = await getJSON();
    const newStructure = createNewStructure(allData);
    
    await saveToFile(newStructure, newScrapedDataFilePath);
    await compareLatestTwoFiles(newStructure);
    await deleteAllOldFilesInFolder(scrapedDataFolderPath);
    await deleteAllOldFilesInFolder(updatesFolderPath);

  } catch (error) {
    console.error("Error in Lambda function:", error);
  }
};
