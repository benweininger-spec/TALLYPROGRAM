// A sample edition in the paper's voice. The demo serves it; Opus can use it
// as the golden example of tone. It passes validateEdition as written.
export const SAMPLE_EDITION = Object.freeze({
  headline: 'STOCKS DRIFT HIGHER; NOBODY CLAIMS CREDIT',
  deck: 'The S&P 500 added a third of a percent on a Tuesday that will not be remembered, which the editors consider the best kind.',
  report: [
    'The broad market closed up 0.34% yesterday in trading the wire services described as "quiet" and this paper describes as "fine." Technology led, as it has most days this year, with the sector fund up 0.8%. Energy gave back 1.1% after crude oil slipped for a second session.',
    'Among large companies, Costco reported quarterly sales up 6% from a year earlier and said membership renewals held at 93%, a figure the company has now repeated so many times that reporters have stopped writing it down. Shares rose 2.4%. Apple was flat. Berkshire Hathaway was flat, as is its custom.',
  ],
  rungs: {
    index: { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', note: 'Up 0.34% yesterday. Owns five hundred companies so the reader does not have to pick one.' },
    sector: { symbol: 'XLK', name: 'Technology Select Sector SPDR', note: 'Led the market again yesterday, up 0.8%. The editors note it has done this before and declined to draw a conclusion.' },
    name: { symbol: 'COST', name: 'Costco', note: 'Reported sales up 6% and renewals at 93%, then rose 2.4%. Sells hot dogs for $1.50, a price last changed in 1985.' },
  },
  closing_note: 'Markets reopen at 9:30. The hot dog remains $1.50.',
});
