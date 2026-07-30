import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class BackendStack extends cdk.Stack{
  constructor(scope: Construct, id: string, props?:cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table
    const vendorTable = new dynamodb.Table(this, 'VendorTable', {
      partitionKey: {
        name: 'vendorId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY // for development only
    })

    // Lambda Functions
    const lambdaEnv = {TABLE_NAME: vendorTable.tableName};

    const createVendorLambda = new NodejsFunction(this, 'CreateVendorHandler', {
      entry: 'lambda/createVendor.ts',
      handler: 'handler',
      environment: lambdaEnv
    })

    const getVendorsLambda = new NodejsFunction(this, 'GetVendorHandler', {
      entry: 'lambda/getVendors.ts',
      handler: 'handler',
      environment: lambdaEnv
    })

    const deleteVendorsLambda = new NodejsFunction(this, 'DeleteVendorHandler', {
      entry: 'lambda/deleteVendor.ts',
      handler: 'handler',
      environment: lambdaEnv
    })

    // Permissions (Least Privilege)
    vendorTable.grantWriteData(createVendorLambda);
    vendorTable.grantReadData(getVendorsLambda);
    vendorTable.grantWriteData(deleteVendorsLambda)

    // cognito user pool
    const userPool = new cognito.UserPool(this, 'VendorUserPool', {
      selfSignUpEnabled: true,
      signInAliases: {email: true},
      autoVerify: {email: true},
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE
      }
    });

    // required to host cognito's internal auth endpoints
    userPool.addDomain('VendorUserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `vendor-tracker-${this.account}`
      }
    })

    const userPoolClient = userPool.addClient('VendorAppClient');

    // API Gateway + authorizer
    const api = new apigateway.RestApi(this, 'VendorApi', {
      restApiName: 'Vendor Service',
      defaultCorsPreflightOptions:{
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization']
      }
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'VendorAuthorizer',
      { cognitoUserPools : [userPool]}
    )

    const authOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    }

    const vendors = api.root.addResource('vendors');
    vendors.addMethod('POST', new apigateway.LambdaIntegration(createVendorLambda), authOptions);
    vendors.addMethod('GET', new apigateway.LambdaIntegration(getVendorsLambda), authOptions);
    vendors.addMethod('DELETE', new apigateway.LambdaIntegration(deleteVendorsLambda), authOptions)

    // S3 bucket (frontend files)
    const siteBucket = new s3.Bucket(this, 'VendorSiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    })

    // CloudFront Distribution (https + cdn)
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior:{
        origin: new origins.S3Origin(siteBucket), // S3Origin is deprecated
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          // redirect all 404s back to index.html so React can handle routing
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        }
      ]
    });

    // deploy frontend files to s3
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('../frontend/out')],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'], // clears cloudfront cache on eveery deploy
    })

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.url })
    new cdk.CfnOutput(this, 'UserPoolId', {value: userPool.userPoolId});
    new cdk.CfnOutput(this, 'UserPoolClientId', {value: userPoolClient.userPoolClientId});
    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${distribution.distributionDomainName}`
    })
  }
}