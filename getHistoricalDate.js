const { getHistoricalRates } = require("dukascopy-node");
 
(async () => {
  try {
    const data = await getHistoricalRates({
      instrument: "eurusd",
      dates: {
        from: new Date("2023-12-15"),
        to: new Date("2025-12-15"),
      },
      timeframe: "h1",
      format: "csv",
    });
 
    console.log(data);
  } catch (error) {
    console.log("error", error);
  }
})();