<template>
  <EndpointRow label="Gemini" path="/api/gemini" tone="blue" :routes="['/models', '/:model/generateContent', '/:model/streamGenerateContent']" />
</template>
