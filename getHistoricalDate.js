const { getHistoricalRates } = require("dukascopy-node");
 
(async () => {
  try {
    const data = await getHistoricalRates({
      instrument: "eurusd",
      dates: {
        from: new Date("2025-11-14"),
        to: new Date("2025-11-16"),
      },
      timeframe: "h1",
      format: "csv",
    });
 
    console.log(data);
  } catch (error) {
    console.log("error", error);
  }
})();