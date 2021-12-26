export function getHugeCSVRequest(req: Request): Request {

    let newReq = new Request("https://www.ishares.com/us/products/239756/ishares-growth-allocation-etf/1467271812596.ajax?fileType=csv&fileName=AOR_holdings&dataType=fund", req);
    newReq.headers.set('cache-control', 'no-cache');
    return newReq;

}
export function getMediumCSVRequest(req: Request): Request {

    let newReq = new Request("https://www.ishares.com/us/products/264615/ishares-core-total-usd-bond-market-etf/1467271812596.ajax?fileType=csv&fileName=IUSB_holdings&dataType=fund", req);
    newReq.headers.set('cache-control', 'no-cache');
    return newReq;

}

export function getSmallCSVRequest(req: Request): Request {

    let newReq = new Request("https://www.ishares.com/us/products/239738/ishares-global-clean-energy-etf/1467271812596.ajax?fileType=csv&dataType=fund", req);
    newReq.headers.set('cache-control', 'no-cache');
    return newReq;

}

export function getCSVPassThrough(request: Request): Promise<Response> {


    return fetch(request).then((res: Response) => {
        res = new Response(res.body, res);
        res.headers.set('Access-Control-Allow-Origin', '*');
        res.headers.set('Access-Control-Allow-Headers', 'Range');
        res.headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Encoding, Content-Length, Content-Range');


        res.headers.set('cache-control', 'no-cache, no-store, s-maxage=0');
        return res;
    });


}

