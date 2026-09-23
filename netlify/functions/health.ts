export default async () => {
  return new Response(
    JSON.stringify({
      status: 'ok',
      platform: 'netlify-functions',
      adminEmail: 'danamieratan@gmail.com',
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
};
